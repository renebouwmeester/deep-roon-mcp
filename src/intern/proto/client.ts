/**
 * RoonClient — high-level facade over the ported remoting stack.
 *
 * Consolidates connection + remoting + object graph + service lookup so a PoC is
 * a few lines. The generic `call()` plus the typed helpers (favorite, play,
 * pause, standby, query-by-title) all run against the live core and are proven
 * end-to-end (favorite UI-confirmed, playback audio-confirmed).
 *
 *   const roon = new RoonClient({ host: 'YOUR_CORE_IP', serverBrokerId });
 *   await roon.connect();
 *   const album = roon.findByTitle('AlbumLite', 'Clube Da Esquina');
 *   await roon.favoriteAlbum(roon.albumIdOf(album!)!, true);
 *   await roon.playAlbumOnZone('HiFi', album!.oid);
 */
import { RoonConnection } from './connection';
import { RemotingClient, CallResult } from './remoting';
import { ObjectGraph, RoonObject, isRef, PropertyType } from './objects';
import { formatMethodSignature, CatalogParam } from '../catalog/signature';
import { Arg, buildArgs } from './serializer';
import { structArg } from './structs';
import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';
import { readFlexLong } from './flex';

/** A field for a populated by-value struct argument. */
export interface StructField {
  name: string;
  propType: PropertyType;
  value: Buffer;
}

export interface RoonClientOptions {
  host: string;
  port?: number;
  serverBrokerId: Buffer;
  /** profile Sooid (value bytes). Defaults to the Profile object the Core
   * pushes into the graph on connect — pass this only to pin a specific
   * profile on a multi-profile Core. */
  profileSooid?: Buffer;
  /** ms to wait for the object graph to settle after getService. */
  settleMs?: number;
}

// The root service guid (stable). getService(root) populates the object graph.
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

export class RoonClient {
  readonly conn: RoonConnection;
  readonly remoting: RemotingClient;
  readonly graph = new ObjectGraph();
  private readonly explicitProfile?: Buffer;
  private cachedProfile?: Buffer;
  /** The profile chosen by name (7 Nov 2026, forum: "after switching profiles, roon_history still returns my first
   *  profile") — see core/session.ts; unset = the explicit option, else the first Profile in the graph. */
  private chosenProfile?: Buffer;
  private settleMs: number;
  /** Added 8 Oct 2026: a PING every 10 s while connected (see RemotingClient.ping); stops at the first failed one —
   *  a caller may replace conn.onclosed, so the close hook alone is not enough. */
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RoonClientOptions) {
    this.conn = new RoonConnection({ host: opts.host, port: opts.port, serverBrokerId: opts.serverBrokerId });
    this.remoting = new RemotingClient(this.conn);
    this.remoting.onPush = (f) => this.graph.ingest(f);
    // Whenever the socket dies (peer disconnect, error, close), fail in-flight
    // requests immediately rather than waiting out their timeouts.
    this.conn.onclosed = () => { this.stopKeepalive(); this.remoting.failPending('broker connection closed'); };
    this.explicitProfile = opts.profileSooid;
    this.settleMs = opts.settleMs ?? 2000;
  }

  /**
   * The profile Sooid used by the library calls: the explicit option when
   * given, else read from the Profile object in the graph (available after
   * connect()). The old hardcoded default was one specific Core's profile id —
   * on every other Core the server matched nothing against it, which is a big
   * part of why search returned no results.
   */
  useProfile(id: Buffer | undefined): void { this.chosenProfile = id; }

  profile(): Buffer {
    if (this.chosenProfile) return this.chosenProfile;
    if (this.explicitProfile) return this.explicitProfile;
    if (this.cachedProfile) return this.cachedProfile;
    for (const o of this.graph.objects.values()) {
      if (!o.typeName.endsWith('.Profile')) continue;
      for (const [k, v] of Object.entries(o.fields)) {
        if (k.endsWith('::ProfileId') && Buffer.isBuffer(v)) {
          this.cachedProfile = v;
          return v;
        }
      }
    }
    throw new Error('no Profile object in the graph yet — connect() first, or pass profileSooid');
  }

  /** Connect, establish the remoting session, and load the object graph. */
  async connect(): Promise<void> {
    await this.conn.connect();
    this.stopKeepalive();
    this.keepalive = setInterval(() => { this.remoting.ping().catch(() => this.stopKeepalive()); }, 10000);
    this.keepalive.unref?.();
    await this.remoting.getService(ROOT_SERVICE_GUID);
    await new Promise((r) => setTimeout(r, this.settleMs));
  }

  close(): void {
    // failPending fires synchronously here (and again, as a no-op, from the
    // socket 'close' event) so callers see rejections before close() returns.
    this.stopKeepalive();
    this.remoting.failPending('client closed');
    this.conn.close();
  }

  private stopKeepalive(): void {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
  }

  // --- object lookup ---

  serviceOid(name: string): bigint {
    const o = this.graph.findByType(name)[0];
    if (!o) throw new Error(`service object "${name}" not found`);
    return o.oid;
  }

  private strField(o: RoonObject, suffix: string): string | undefined {
    for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'string') return v;
    return undefined;
  }

  /** Find a loaded object of a type by its Title/Name (case-insensitive). */
  findByTitle(typeName: string, title: string): RoonObject | undefined {
    return this.graph.findByType(typeName).find((o) => {
      const t = this.strField(o, '::Title') ?? this.strField(o, '::Name');
      return t?.toLowerCase() === title.toLowerCase();
    });
  }

  /** Resolve a zone object id by the name of one of its endpoints. */
  zoneByName(name: string): bigint | undefined {
    for (const e of this.graph.findByType('Endpoint')) {
      if (this.strField(e, '::Name')?.toLowerCase().includes(name.toLowerCase())) {
        for (const [k, v] of Object.entries(e.fields)) if (k.endsWith('::Zone') && isRef(v)) return (v as any).$ref;
      }
    }
    return undefined;
  }

  /** Resolve an endpoint object id by name. */
  endpointByName(name: string): bigint | undefined {
    const e = this.graph
      .findByType('Endpoint')
      .find((x) => this.strField(x, '::Name')?.toLowerCase().includes(name.toLowerCase()));
    return e?.oid;
  }

  // --- generic call ---

  /** Call a method by service + name + params + pre-built args; returns the result. */
  call(service: string, method: string, params: CatalogParam[], args: Buffer, objectId?: bigint): Promise<CallResult> {
    const sig = formatMethodSignature(service, method, params);
    return this.remoting.callMethod(objectId ?? this.serviceOid(service), sig, args);
  }

  /** Build a sparse value using the shared full schema and stable field indexes. */
  structArg(typeName: string, fields: StructField[]): Buffer {
    return structArg(this.remoting, typeName, fields);
  }

  /** ms to wait for UnifiedSearch result objects to stream into the graph. */
  private searchSettleMs = 2000;

  /**
   * Library::UnifiedSearch — library and streaming-catalog results.
   * Resolve only the callback's result graph. TopSearchResults keep the Core's
   * ranking, followed by highlighted albums and category lists in a stable
   * order. Version lists preserve their order; repeated OIDs appear once.
   * Opt in to playlist and genre hits with includePlaylistsAndGenres. Their
   * lists follow ranked hits/highlights and precede broad categories so large
   * performer lists do not consume the entire result limit first.
   */
  async search(terms: string, maxCount = 50, includePlaylistsAndGenres = false): Promise<RoonObject[]> {
    const params = this.structArg('Sooloos.Broker.Api.SearchParameters', [
      {
        name: 'System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId',
        propType: PropertyType.Sooid,
        value: new BinaryWriter().sooid(this.profile()).toBuffer(),
      },
      {
        name: 'string Sooloos.Broker.Api.SearchParameters::Terms',
        propType: PropertyType.String,
        value: new BinaryWriter().string(terms).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(maxCount).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(20).toBuffer(),
      },
    ]);
    const res = await this.call(
      'Library',
      'UnifiedSearch',
      [
        { type: 'SearchParameters', name: 'p' },
        { type: 'ResultCallback<UnifiedSearchResults>', name: 'cb' },
      ],
      params,
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`UnifiedSearch failed: ${res.status}`);
    const result = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    const [, end] = readFlexLong(res.payload, 0);
    if (!isRef(result) || end !== res.payload.length || res.payload.length > 10) {
      throw new Error('UnifiedSearch returned an invalid result reference');
    }
    const deadline = Date.now() + this.searchSettleMs;
    for (;;) {
      const objects = this.searchResultObjects(result.$ref, includePlaylistsAndGenres);
      if (objects !== undefined) return objects.slice(0, Math.max(0, maxCount));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('UnifiedSearch result graph is incomplete');
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
  }

  /** undefined means a referenced membership object has not arrived yet. */
  private searchResultObjects(rootId: bigint, includePlaylistsAndGenres: boolean): RoonObject[] | undefined {
    const root = this.graph.getObject(rootId);
    if (!root) return undefined;
    if (!root.typeName.endsWith('.UnifiedSearchResults')) {
      throw new Error('UnifiedSearch returned an unexpected result type');
    }
    const rootMembers = ['TopSearchResults', 'TopAlbum', 'TopLibraryAlbum',
      'Performers', 'Composers', 'Albums', 'Tracks', 'Works'];
    // Full entities implement their Lite interfaces and can already occupy a
    // returned OID in the shared graph. They remain terminal search hits.
    const leaves = new Set(['AlbumLite', 'TrackLite', 'PerformerLite', 'WorkLite',
      'Album', 'Track', 'Performer', 'Work']);
    if (includePlaylistsAndGenres) {
      rootMembers.splice(3, 0, 'Playlists', 'Genres');
      for (const type of ['Playlist', 'BrowserGenre', 'GenreLite']) leaves.add(type);
    }
    const seen = new Set<bigint>();
    const out: RoonObject[] = [];
    let complete = true;
    const member = (fields: Record<string, unknown>, name: string): unknown =>
      Object.entries(fields).find(([key]) => key.endsWith(`::${name}`))?.[1];
    const visit = (value: unknown): void => {
      if (value === null || value === undefined) return;
      let type: string;
      let fields: Record<string, unknown>;
      if (isRef(value)) {
        if (seen.has(value.$ref)) return;
        seen.add(value.$ref);
        const object = this.graph.getObject(value.$ref);
        if (!object) { complete = false; return; }
        type = object.typeName;
        fields = object.fields;
        if (leaves.has(type.slice(type.lastIndexOf('.') + 1))) {
          out.push(object);
          return; // An album's metadata references are not search membership.
        }
      } else if (typeof value === 'object' && '$type' in value) {
        fields = value as Record<string, unknown>;
        type = String(fields.$type);
      } else {
        complete = false;
        return;
      }
      if (/(^|\.)DataList</.test(type)) {
        const items = fields.$items;
        if (!Array.isArray(items) || !Number.isInteger(fields.$count) ||
            (fields.$count as number) < 0 || items.length !== fields.$count) {
          complete = false;
          return;
        }
        for (const item of items) visit(item);
      } else if (type.endsWith('.AlbumLiteVersions') || type.endsWith('.TrackLiteVersions')) {
        const items = member(fields, type.endsWith('.AlbumLiteVersions') ? 'Albums' : 'Tracks');
        if (items === undefined) complete = false;
        else visit(items);
      } else if (type.endsWith('.TopSearchResult')) {
        for (const name of ['Artist', 'Album', 'Track', 'Work',
          'LibraryArtist', 'LibraryAlbum', 'LibraryTrack', 'LibraryWork']) visit(member(fields, name));
        if (includePlaylistsAndGenres) {
          for (const name of ['Playlist', 'Genre']) visit(member(fields, name));
        }
      } else {
        complete = false; // A known membership edge must resolve to a supported type.
      }
    };
    // A PUSHSTUB carries only identity; await the populated result object.
    if (!Object.keys(root.fields).some((key) => rootMembers.some((name) => key.endsWith(`::${name}`)))) {
      return undefined;
    }
    for (const name of rootMembers) visit(member(root.fields, name));
    return complete ? out : undefined;
  }

  /** Best-effort display title for a result object. */
  titleOf(o: RoonObject): string {
    return this.strField(o, '::Title') ?? this.strField(o, '::Name') ?? '?';
  }

  /**
   * Search albums via VirtualAlbumQuery + RetainPage (the paged query path the
   * official client uses). Returns the AlbumLite objects on the first page.
   *   VirtualAlbumQuery(profile, criteria{TextFilter}, params{PageSize}) ->
   *   VirtualAlbumLiteQuery oid -> RetainPage(0) -> items push.
   */
  async searchAlbums(term: string, pageSize = 40): Promise<RoonObject[]> {
    const criteria = this.structArg('Sooloos.Broker.Api.AlbumQueryCriteria', [
      { name: 'UiLanguage', propType: PropertyType.String, value: new BinaryWriter().string('en').toBuffer() },
      { name: 'TextFilter', propType: PropertyType.String, value: new BinaryWriter().string(term).toBuffer() },
    ]);
    const params = this.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [
      { name: 'PageSize', propType: PropertyType.Int, value: new BinaryWriter().integer(pageSize).toBuffer() },
    ]);
    const args = Buffer.concat([buildArgs([Arg.sooid(this.profile())]), criteria, params]);
    const res = await this.call(
      'Library',
      'VirtualAlbumQuery',
      [
        { type: 'Sooid', name: 'profileid' },
        { type: 'AlbumQueryCriteria', name: 'criteria' },
        { type: 'VirtualQueryParameters', name: 'queryparams' },
        { type: 'ResultCallback<VirtualAlbumLiteQuery>', name: 'cb' },
      ],
      args,
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`VirtualAlbumQuery failed: ${res.status}`);
    // payload = object reference to the VirtualAlbumLiteQuery (GetObject: flexlong oid)
    const [queryOid] = readFlexLong(Uint8Array.from(res.payload), 0);
    await new Promise((r) => setTimeout(r, 400));
    // RetainPage(0) loads the first page; items then push.
    await this.call(
      'VirtualAlbumLiteQuery',
      'RetainPage',
      [
        { type: 'int', name: 'pagen' },
        { type: 'ResultCallback', name: 'cb' },
      ],
      buildArgs([Arg.int(0)]),
      queryOid
    );
    await new Promise((r) => setTimeout(r, 1500));
    // Collect AlbumLite objects referenced by the query's page items.
    const q = this.graph.getObject(queryOid);
    const items: any[] = (q?.fields as any)?.$items || [];
    const out: RoonObject[] = [];
    for (const it of items) {
      const oid = isRef(it) ? it.$ref : undefined;
      const o = oid !== undefined ? this.graph.getObject(oid) : undefined;
      if (o && this.strField(o, '::Title')) out.push(o);
    }
    // Fallback: any AlbumLite whose title contains the term (in case items are inline).
    if (!out.length) {
      const needle = term.toLowerCase();
      for (const o of this.graph.findByType('AlbumLite')) {
        const t = this.strField(o, '::Title');
        if (t && t.toLowerCase().includes(needle)) out.push(o);
      }
    }
    return out;
  }

  // --- typed convenience methods (proven live) ---

  /** Serialize one AlbumBase as an inline AlbumLink value struct {AlbumId, Broker}. */
  private albumLink(albumId: bigint): Buffer {
    return this.structArg('Sooloos.Broker.Api.AlbumLink', [
      {
        name: 'long Sooloos.Broker.Api.AlbumLink::AlbumId',
        propType: PropertyType.Long,
        value: new BinaryWriter().long(albumId).toBuffer(),
      },
      {
        name: 'Sooloos.Broker.Api.Broker Sooloos.Broker.Api.AlbumLink::Broker',
        propType: PropertyType.Object,
        value: new BinaryWriter().long(this.serviceOid('Broker')).toBuffer(),
      },
    ]);
  }

  /**
   * Favorite/unfavorite an album (FavoriteBanState: None=0, Favorite=1, Ban=2).
   *
   * Takes the STABLE album id (albumIdOf), not a session oid. Uses the
   * IEnumerable<AlbumBase> overload the official client uses; each element is
   * an inline AlbumLink value struct {AlbumId, Broker}, and the collection is
   * length-prefixed (Arg.collection). Both facts came from a byte-for-byte
   * capture diff against the official client — the previous single-AlbumBase
   * call with a bare object ref was silently ignored, and encoding the
   * collection as a naive count+refs list stalls the Core.
   */
  favoriteAlbum(albumId: bigint, favorite: boolean): Promise<CallResult> {
    return this.call(
      'Library',
      'FavoriteOrBan',
      [
        { type: 'Sooid', name: 'profileid' },
        { type: 'IEnumerable<AlbumBase>', name: 'albums' },
        { type: 'FavoriteBanState', name: 'state' },
        { type: 'ResultCallback', name: 'cb' },
      ],
      buildArgs([
        Arg.sooid(this.profile()),
        Arg.collection([this.albumLink(albumId)]),
        Arg.enum_(favorite ? 1 : 0),
      ]),
      this.serviceOid('Library')
    );
  }

  /** Play an album on a zone (default PlayParameters). */
  async playAlbum(zoneOid: bigint, albumOid: bigint): Promise<CallResult> {
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      this.structArg('Sooloos.Broker.Api.PlayParameters', []),
      buildArgs([Arg.ref(albumOid), Arg.bool(false), Arg.bool(false)]),
    ]);
    return this.call(
      'Transport',
      'PlayAlbum',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'AlbumBase', name: 'album' },
        { type: 'bool', name: 'favoritesonly' },
        { type: 'bool', name: 'includehidden' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Play a single track on a zone (default PlayParameters). */
  async playTrack(zoneOid: bigint, trackOid: bigint): Promise<CallResult> {
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      this.structArg('Sooloos.Broker.Api.PlayParameters', []),
      buildArgs([Arg.ref(trackOid)]),
    ]);
    return this.call(
      'Transport',
      'PlayTrack',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'TrackBase', name: 'track' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Convenience: find an album by title and play it on a named zone. */
  async playAlbumOnZone(zoneName: string, albumTitle: string): Promise<CallResult> {
    const zone = this.zoneByName(zoneName);
    const album = this.findByTitle('AlbumLite', albumTitle) ?? this.findByTitle('Album', albumTitle);
    if (!zone) throw new Error(`zone "${zoneName}" not found`);
    if (!album) throw new Error(`album "${albumTitle}" not loaded`);
    return this.playAlbum(zone, album.oid);
  }

  /** Fire-and-forget zone transport control (Pause/Play/Stop/Next/Previous/...). */
  zoneControl(zoneOid: bigint, method: 'Pause' | 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'): void {
    this.remoting.callMethodNoReply(zoneOid, formatMethodSignature('Zone', method, []), Buffer.alloc(0));
  }

  /** Power a device off (standby) — fire-and-forget on the endpoint. */
  standby(endpointOid: bigint): void {
    this.remoting.callMethodNoReply(endpointOid, formatMethodSignature('Endpoint', 'Standby', []), Buffer.alloc(0));
  }

  /** Power a device on (convenience switch) — expects a response. */
  powerOn(endpointOid: bigint): Promise<CallResult> {
    return this.remoting.callMethod(
      endpointOid,
      formatMethodSignature('Endpoint', 'ConvenienceSwitch', [{ type: 'ResultCallback', name: 'cb' }]),
      Buffer.alloc(0)
    );
  }

  // --- metadata editing: read side (Phase E) ---

  /**
   * Read an album's editable metadata via Library::GetAlbumEditInfo. The result
   * is returned by-value (an inline AlbumEditInfo struct of Edit*Info<T> wrappers,
   * NOT pushed into the graph), so we decode it from the response payload. Each
   * field exposes its effective `Value`/`Values` plus whether the user has a local
   * edit layer. Proven live (read-only, safe). See docs Phase E.
   */
  async getAlbumEditInfo(albumOid: bigint): Promise<AlbumEditInfo> {
    const res = await this.call(
      'Library',
      'GetAlbumEditInfo',
      [
        { type: 'AlbumBase', name: 'album' },
        { type: 'ResultCallback<AlbumEditInfo>', name: 'cb' },
      ],
      buildArgs([Arg.ref(albumOid)]),
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`GetAlbumEditInfo failed: ${res.status}`);
    const decoded = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    return parseAlbumEditInfo(decoded as Record<string, unknown>);
  }

  // Geen schrijfkant voor albumgegevens (René, 26 okt 2026): editAlbum (titel, waardering, genres, labels via
  // Library::Edit) is eruit — er hing geen tool aan, en wat er niet in staat kan ook niet per ongeluk aangesloten worden.

  /** AlbumLite::AlbumId (the long id favoriteAlbum keys on). */
  albumIdOf(album: RoonObject): bigint | undefined {
    for (const [k, v] of Object.entries(album.fields)) {
      if (k.endsWith('::AlbumId')) return typeof v === 'bigint' ? v : BigInt(String(v));
    }
    return undefined;
  }
}

// --- AlbumEditInfo decoding (by-value return) ---

/** One editable field: the effective value + whether the user edited it. */
export interface EditField<T> {
  value: T | undefined;
  /** the metadata (publisher) value, before any local/user edit. */
  metadataValue?: T;
  /** true when the user has a local edit overriding metadata. */
  edited: boolean;
}

export interface AlbumEditInfo {
  title: EditField<string>;
  version: EditField<string>;
  performedBy: EditField<string>;
  genres: EditField<string[]>;
  labels: EditField<string[]>;
  rating: EditField<number>;
  type: EditField<number>;
  isCompilation: EditField<boolean>;
  isLive: EditField<boolean>;
  isPick: EditField<boolean>;
  containsExplicitContent: EditField<boolean>;
  isUserHidden: EditField<boolean>;
  country: EditField<string>;
  catalogNumber: EditField<string>;
  productCode: EditField<string>;
  /** the full decoded struct, for fields not surfaced above. */
  raw: Record<string, unknown>;
}

/** Read a member of a decoded struct by its `::suffix` (keys are fully-qualified). */
function member(obj: Record<string, unknown> | undefined, suffix: string): unknown {
  if (!obj) return undefined;
  for (const [k, v] of Object.entries(obj)) if (k.endsWith(suffix)) return v;
  return undefined;
}

/** A LengthPrefixed IList<string> decodes to a Buffer of flexInt(count)+string*. */
function decodeStringList(v: unknown): string[] | undefined {
  if (!Buffer.isBuffer(v)) return Array.isArray(v) ? (v as string[]) : undefined;
  const r = new BinaryReader(Uint8Array.from(v));
  const out: string[] = [];
  const count = r.flexInt();
  for (let i = 0; i < count && r.remaining > 0; i++) out.push(r.string() ?? '');
  return out;
}

/** Extract one Edit*Info<T> wrapper field from the AlbumEditInfo struct. */
function editField<T>(info: Record<string, unknown>, fieldSuffix: string, list = false): EditField<T> {
  const wrapper = member(info, `::${fieldSuffix}`) as Record<string, unknown> | undefined;
  const rawValue = member(wrapper, list ? '::Values' : '::Value');
  const rawMeta = member(wrapper, list ? '::MetadataValues' : '::MetadataValue');
  const value = (list ? decodeStringList(rawValue) : rawValue) as T | undefined;
  const metadataValue = (list ? decodeStringList(rawMeta) : rawMeta) as T | undefined;
  return { value, metadataValue, edited: member(wrapper, '::HasEditLayer') === true };
}

function parseAlbumEditInfo(decoded: Record<string, unknown>): AlbumEditInfo {
  return {
    title: editField<string>(decoded, 'Title'),
    version: editField<string>(decoded, 'Version'),
    performedBy: editField<string>(decoded, 'PerformedBy'),
    genres: editField<string[]>(decoded, 'Genres', true),
    labels: editField<string[]>(decoded, 'Labels', true),
    rating: editField<number>(decoded, 'Rating'),
    type: editField<number>(decoded, 'Type'),
    isCompilation: editField<boolean>(decoded, 'IsCompilation'),
    isLive: editField<boolean>(decoded, 'IsLive'),
    isPick: editField<boolean>(decoded, 'IsPick'),
    containsExplicitContent: editField<boolean>(decoded, 'ContainsExplicitContent'),
    isUserHidden: editField<boolean>(decoded, 'IsUserHidden'),
    country: editField<string>(decoded, 'Country'),
    catalogNumber: editField<string>(decoded, 'CatalogNumber'),
    productCode: editField<string>(decoded, 'ProductCode'),
    raw: decoded,
  };
}
