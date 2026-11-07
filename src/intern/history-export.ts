import { CatalogParam } from './catalog/signature';
import { readFlexLong } from './proto/flex';
import { PropertyType, RoonObject } from './proto/objects';
import { CallResult } from './proto/remoting';
import { Arg, buildArgs, inlineStruct } from './proto/serializer';
import { BinaryWriter } from './proto/writer';

const SIG_RETAIN_PAGE =
  'Sooloos.Broker.Api.VirtualHistoryPlayQuery::RetainPage(int, Base.ResultCallback)';
const SIG_RELEASE_PAGE =
  'Sooloos.Broker.Api.VirtualHistoryPlayQuery::ReleasePage(int, Base.ResultCallback)';
const SIG_DISPOSE = 'Sooloos.Broker.Api.VirtualHistoryPlayQuery::Dispose()';

const TICKS_MASK = (1n << 62n) - 1n;
const UNIX_EPOCH_TICKS = 621355968000000000n;

interface HistoryGraph {
  findByType(shortName: string): RoonObject[];
  getObject(oid: bigint | number): RoonObject | undefined;
}

interface HistoryRemoting {
  defineType(typeName: string, members?: { name: string; propType: number }[]): number;
  callMethod(objectId: bigint | number, signature: string, args: Buffer): Promise<CallResult>;
  callMethodNoReply(objectId: bigint | number, signature: string, args: Buffer): void;
}

export interface HistoryExportClient {
  readonly graph: HistoryGraph;
  readonly remoting: HistoryRemoting;
  profile(): Buffer;
  structArg(
    typeName: string,
    fields: { name: string; propType: PropertyType; value: Buffer }[]
  ): Buffer;
  call(
    service: string,
    method: string,
    params: CatalogParam[],
    args: Buffer,
    objectId?: bigint
  ): Promise<CallResult>;
}

export interface HistoryExportOptions {
  limit: number;
  pageSize?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Stop paging after this moment (epoch ms) and return what came: `complete` says whether it got everything. */
  deadline?: number;
  /** Stop paging once this says enough (the events so far, newest first per page). */
  enough?: (events: HistoryEvent[]) => boolean;
  /** Roon's own date filter (HistoryQueryCriteria::MinPlayDate / MaxPlayDate): only plays in this range — the query
   *  starts there instead of paging through everything newer (0.5.1). */
  minDate?: Date;
  maxDate?: Date;
}

export interface HistoryEvent {
  playedAt: string;
  artist: string;
  title: string;
  album?: string;
  completionPct?: number;
  roonTrackId?: string;
}

export interface HistoryExportResult {
  total: number;
  events: HistoryEvent[];
  skipped: number;
  duplicates: number;
  /** False when the deadline or `enough` stopped the paging before the target. */
  complete?: boolean;
}

interface HistorySnapshot {
  oid: string;
  identity: string;
  time: bigint;
  event?: HistoryEvent;
}

function field(o: RoonObject | undefined, suffix: string): unknown {
  if (!o) return undefined;
  return Object.entries(o.fields).find(([key]) => key.endsWith(suffix))?.[1];
}

function refOf(value: unknown): bigint | undefined {
  if (value && typeof value === 'object' && '$ref' in value) {
    return BigInt(String((value as { $ref: unknown }).$ref));
  }
  return undefined;
}

function normalizedTicks(raw: bigint): bigint {
  return raw & TICKS_MASK;
}

function dotnetTicksToIso(raw: bigint): string {
  return new Date(Number((normalizedTicks(raw) - UNIX_EPOCH_TICKS) / 10000n)).toISOString();
}

async function pollFor<T>(
  label: string,
  timeoutMs: number,
  pollIntervalMs: number,
  read: () => T | undefined
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function pollUntil(
  timeoutMs: number,
  pollIntervalMs: number,
  ready: () => boolean
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function identityOf(play: RoonObject): string | undefined {
  const identity = field(play, '::HistoryPlayId');
  if (typeof identity === 'bigint') return `bigint:${identity.toString()}`;
  if (typeof identity === 'number' && Number.isFinite(identity)) return `number:${identity}`;
  if (typeof identity === 'string') return `string:${identity}`;
  if (Buffer.isBuffer(identity)) return `buffer:${identity.toString('hex')}`;
  return undefined;
}

function assembleEvent(client: HistoryExportClient, play: RoonObject): HistoryEvent | undefined {
  const time = field(play, '::Time');
  if (typeof time !== 'bigint') return undefined;

  const trackRef = refOf(field(play, '::Track'));
  const track = trackRef === undefined ? undefined : client.graph.getObject(trackRef);
  const albumRef = refOf(field(track, '::Album'));
  const album = albumRef === undefined ? undefined : client.graph.getObject(albumRef);
  const title = field(track, '::Title');
  const artist = field(album, '::PerformedBy');
  if (typeof title !== 'string' || typeof artist !== 'string') return undefined;

  const event: HistoryEvent = {
    playedAt: dotnetTicksToIso(time),
    artist,
    title,
  };
  const albumTitle = field(album, '::Title');
  if (typeof albumTitle === 'string') event.album = albumTitle;
  const secondsPlayed = field(play, '::SecondsPlayed');
  const lengthSeconds = field(track, '::LengthSeconds');
  if (typeof secondsPlayed === 'number' && typeof lengthSeconds === 'number' && lengthSeconds > 0) {
    event.completionPct = Math.min(100, Math.round((secondsPlayed / lengthSeconds) * 1000) / 10);
  }
  const link = field(play, '::TrackBase');
  if (link && typeof link === 'object') {
    const trackId = Object.entries(link as Record<string, unknown>).find(([key]) =>
      key.endsWith('::TrackId')
    )?.[1];
    if (trackId !== undefined) event.roonTrackId = String(trackId);
  }
  return event;
}

function validateOptions(options: HistoryExportOptions): Required<Omit<HistoryExportOptions, 'deadline' | 'enough' | 'minDate' | 'maxDate'>> {
  const pageSize = options.pageSize ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
    throw new Error('history limit must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error('history page size must be a positive safe integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('history timeout must be finite and non-negative');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('history poll interval must be finite and non-negative');
  }
  return { limit: options.limit, pageSize, timeoutMs, pollIntervalMs };
}

/**
 * Export play history through the read-only VirtualHistoryQuery lifecycle.
 * Page membership, identity, and Time are fail-closed. Display references get
 * a bounded hydration window and are reported as skips if still unresolved.
 * Use a fresh client graph: query membership cannot be recovered reliably from
 * a graph that already contains HistoryPlay objects from an earlier query.
 */
export async function exportPlayHistory(
  client: HistoryExportClient,
  options: HistoryExportOptions
): Promise<HistoryExportResult> {
  const { limit, pageSize, timeoutMs, pollIntervalMs } = validateOptions(options);
  if (client.graph.findByType('HistoryPlay').length > 0) {
    throw new Error('history export requires a fresh client graph with no HistoryPlay objects');
  }

  // A .NET DateTime? as Roon reads it: present, then DateTime.ToBinary — the ticks with Kind = Utc in the top bits.
  const dateField = (which: 'MinPlayDate' | 'MaxPlayDate', d: Date) => ({
    name: `System.DateTime? Sooloos.Broker.Api.HistoryQueryCriteria::${which}`,
    propType: PropertyType.NullableDateTime,
    value: new BinaryWriter().boolean(true).long((BigInt(d.getTime()) * 10000n + UNIX_EPOCH_TICKS) | (1n << 62n)).toBuffer(),
  });
  const dates = [
    ...(options.minDate ? [dateField('MinPlayDate', options.minDate)] : []),
    ...(options.maxDate ? [dateField('MaxPlayDate', options.maxDate)] : []),
  ];
  const criteria = dates.length
    ? client.structArg('Sooloos.Broker.Api.HistoryQueryCriteria', dates)
    : inlineStruct(client.remoting.defineType('Sooloos.Broker.Api.HistoryQueryCriteria', []));
  const params = client.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [
    {
      name: 'int Sooloos.Broker.Api.VirtualQueryParameters::PageSize',
      propType: PropertyType.Int,
      value: new BinaryWriter().integer(pageSize).toBuffer(),
    },
  ]);
  const args = Buffer.concat([buildArgs([Arg.sooid(client.profile())]), criteria, params]);
  const result = await client.call(
    'Library',
    'VirtualHistoryQuery',
    [
      { type: 'Sooid', name: 'profileid' },
      { type: 'HistoryQueryCriteria', name: 'criteria' },
      { type: 'VirtualQueryParameters', name: 'queryparams' },
      { type: 'ResultCallback<VirtualHistoryPlayQuery>', name: 'cb' },
    ],
    args
  );
  if (!result.success) throw new Error(`VirtualHistoryQuery failed: ${result.status}`);
  const [queryOid] = readFlexLong(Uint8Array.from(result.payload), 0);

  try {
    // An empty history (7 Nov 2026, a new profile): Roon's sparse encoding leaves a Count of 0 out, so the query object
    // comes without one. Seen for 1.5 s with no Count = 0.
    let seen = 0;
    const total = await pollFor('history Count', timeoutMs, pollIntervalMs, () => {
      const q = client.graph.getObject(queryOid);
      const count = field(q, '::Count');
      if (count === undefined) {
        if (q && !seen) seen = Date.now();
        return q && Date.now() - seen >= 1500 ? 0 : undefined;
      }
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error(`invalid history Count: ${String(count)}`);
      }
      return count as number;
    });
    const target = Math.min(total, limit);
    if (target === 0) return { total, events: [], skipped: 0, duplicates: 0 };

    const plays = new Map<string, RoonObject>();
    const snapshottedOids = new Set<string>();
    const snapshots: HistorySnapshot[] = [];
    const harvest = (): number => {
      for (const play of client.graph.findByType('HistoryPlay')) {
        plays.set(play.oid.toString(), play);
      }
      return plays.size;
    };
    let complete = true;
    for (let page = 0; page < Math.ceil(target / pageSize); page++) {
      // A deadline or "enough" (0.5.1): a long history (tens of thousands of plays since 2015) doesn't fit in one answer.
      if (page > 0 && ((options.deadline && Date.now() > options.deadline) || (options.enough && options.enough(snapshots.map((x) => x.event).filter((e): e is HistoryEvent => !!e))))) { complete = false; break; }
      let acquired = false;
      try {
        const retained = await client.remoting.callMethod(
          queryOid,
          SIG_RETAIN_PAGE,
          buildArgs([Arg.int(page)])
        );
        if (!retained.success) throw new Error(`RetainPage(${page}) failed: ${retained.status}`);
        acquired = true;
        const pageTarget = Math.min(total, (page + 1) * pageSize);
        await pollFor(`history page ${page}`, timeoutMs, pollIntervalMs, () =>
          harvest() >= pageTarget ? plays.size : undefined
        );

        const pagePlays = [...plays.values()].filter(
          (play) => !snapshottedOids.has(play.oid.toString())
        );
        await pollFor(`history page ${page} identity and Time`, timeoutMs, pollIntervalMs, () =>
          pagePlays.every(
            (play) => identityOf(play) !== undefined && typeof field(play, '::Time') === 'bigint'
          )
            ? true
            : undefined
        );

        await pollUntil(timeoutMs, pollIntervalMs, () =>
          pagePlays.every((play) => assembleEvent(client, play) !== undefined)
        );
        for (const play of pagePlays) {
          snapshots.push({
            oid: play.oid.toString(),
            identity: identityOf(play)!,
            time: field(play, '::Time') as bigint,
            event: assembleEvent(client, play),
          });
          snapshottedOids.add(play.oid.toString());
        }
      } finally {
        if (acquired) {
          client.remoting.callMethodNoReply(
            queryOid,
            SIG_RELEASE_PAGE,
            buildArgs([Arg.int(page)])
          );
        }
      }
    }

    const byIdentity = new Map<string, HistorySnapshot>();
    let duplicates = 0;
    for (const snapshot of snapshots) {
      const existing = byIdentity.get(snapshot.identity);
      if (!existing) {
        byIdentity.set(snapshot.identity, snapshot);
        continue;
      }
      duplicates++;
      const snapshotIsBetter =
        (!existing.event && snapshot.event !== undefined) ||
        ((existing.event === undefined) === (snapshot.event === undefined) &&
          snapshot.time > existing.time);
      if (snapshotIsBetter) {
        byIdentity.set(snapshot.identity, snapshot);
      }
    }

    const ordered = [...byIdentity.values()].sort((a, b) => {
      const aTicks = normalizedTicks(a.time);
      const bTicks = normalizedTicks(b.time);
      return aTicks === bTicks ? a.oid.localeCompare(b.oid) : aTicks > bTicks ? -1 : 1;
    });
    const events: HistoryEvent[] = [];
    let skipped = 0;
    for (const snapshot of ordered) {
      if (!snapshot.event) {
        skipped++;
        continue;
      }
      events.push(snapshot.event);
      if (events.length >= target) break;
    }
    return { total, events, skipped, duplicates, complete };
  } finally {
    client.remoting.callMethodNoReply(queryOid, SIG_DISPOSE, Buffer.alloc(0));
  }
}
