// Playing and controlling: albums and tracks on a zone, the transport buttons, seek, shuffle / repeat / Roon Radio, the
// queue, grouping, transfer, the sleep timer, standby, and the cover. These change what plays — the tools say so.
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { BinaryReader } from '../intern/proto/reader';
import { BinaryWriter } from '../intern/proto/writer';
import { formatMethodSignature } from '../intern/catalog/signature';
import { withCore, findTarget, RoonError } from '../core/session';
import { officialZone } from '../core/official';
import { log } from '../core/log';
import { Any, C, clean, duration, field, imageKey, items, obj, short, wait, trackArtist } from './graph';
import { findAlbum, findTracks } from './library';
import { findZone, zoneNames } from './zones';

export type How = 'now' | 'next' | 'queue';
// PlayPriority: Now = 0, Interrupt = 1, PlayBefore = 2, Next = 3, Queue = 4.
export const PRIORITY: Record<How, number> = { now: 0, next: 3, queue: 4 };

/** PlayParameters: the priority, and Shuffle — Roon's own Shuffle button on an album or playlist (the queue starts
 *  shuffled; shuffling after loading would play track 1 first). */
export function playParams(c: C, p: number, shuffle = false): Buffer {
  const members = [];
  if (p !== 0) members.push({ name: 'Priority', propType: 9, value: new BinaryWriter().flexInt(p).toBuffer() });
  if (shuffle) members.push({ name: 'Shuffle', propType: 2, value: new BinaryWriter().boolean(true).toBuffer() });
  return c.structArg('Sooloos.Broker.Api.PlayParameters', members);
}
function playAlbum(c: C, zone: bigint, album: bigint, p: number, shuffle: boolean, includeHidden = false) {
  const args = Buffer.concat([buildArgs([Arg.ref(zone), Arg.sooid(c.profile())]), playParams(c, p, shuffle), buildArgs([Arg.ref(album), Arg.bool(false), Arg.bool(includeHidden)])]);
  return c.call('Transport', 'PlayAlbum',
    [{ type: 'Zone', name: 'zone' }, { type: 'Sooid', name: 'profileid' }, { type: 'PlayParameters', name: 'parameters' }, { type: 'AlbumBase', name: 'album' },
     { type: 'bool', name: 'favoritesonly' }, { type: 'bool', name: 'includehidden' }, { type: 'ResultCallback<PlayFeedback>', name: 'cb' }], args, c.serviceOid('Transport'));
}
function playTrack(c: C, zone: bigint, track: bigint, p: number) {
  const args = Buffer.concat([buildArgs([Arg.ref(zone), Arg.sooid(c.profile())]), playParams(c, p), buildArgs([Arg.ref(track)])]);
  return c.call('Transport', 'PlayTrack',
    [{ type: 'Zone', name: 'zone' }, { type: 'Sooid', name: 'profileid' }, { type: 'PlayParameters', name: 'parameters' }, { type: 'TrackBase', name: 'track' },
     { type: 'ResultCallback<PlayFeedback>', name: 'cb' }], args, c.serviceOid('Transport'));
}

/** After "now": does it sound? Roon says ok once the queue stands; whether the stream comes shows a moment later (a
 *  Qobuz track that gives no data; a device waking from standby takes a few seconds). Look every second, up to 12 s. */
export async function started(zoneName: string, p: number): Promise<{ started?: boolean; state?: string }> {
  if (p !== 0) return {};
  const t0 = Date.now();
  let state: string | undefined;
  while (Date.now() - t0 < 12000) {
    await wait(1000);
    const z = officialZone(zoneName);
    if (!z) return {};
    state = z.state;
    if (state === 'playing' || state === 'loading') return { started: true };
  }
  log(`not started: ${zoneName} is ${state} ${Math.round((Date.now() - t0) / 1000)} s after the start`);
  return { started: false, state };
}

/** `includeHidden` (29 Oct 2026, Stacks): an album Roon hides — without it Roon plays none of its tracks. */
export async function play(key: string, zoneName: string, how: How, shuffle: boolean, includeHidden = false) {
  const p = PRIORITY[how];
  const r = await withCore(async (c) => {
    const z = findZone(c, zoneName);
    const album = await findAlbum(c, key);
    const res = await playAlbum(c, z.oid, album.oid, p, shuffle, includeHidden);
    log(`play (${how}${shuffle ? ', shuffled' : ''}): ${field(album, 'Title')} on ${z.name} → ${res.success ? 'ok' : res.status}`);
    if (!res.success) throw new RoonError(`Roon refused to play it (${res.status})`);
    return { zone: z.name, how, shuffle: shuffle || undefined, title: field(album, 'Title'), artist: clean(field(album, 'PerformedBy')) };
  });
  return { ok: true, ...r, ...(await started(r.zone, p)) };
}

/** A list of tracks, in order: each one with PlayTrack — "now" = the first now and the rest at the end of the queue;
 *  "queue" = all at the end; "next" = in reverse as next, so the first of the list also plays first. */
export async function playTracks(keys: string[], zoneName: string, how: How) {
  const p = PRIORITY[how];
  const r = await withCore(async (c) => {
    const z = findZone(c, zoneName);
    const tracks = await findTracks(c, keys);
    const order = p === 3 ? [...tracks].reverse() : tracks;
    let done = 0;
    for (let i = 0; i < order.length; i++) {
      const res = await playTrack(c, z.oid, order[i].oid, p === 0 ? (i === 0 ? 0 : 4) : p);
      if (!res.success) throw new RoonError(`Roon refused track ${i + 1} of ${order.length} (${res.status}); ${done} were queued`);
      done += 1;
      // "Now" empties the queue a moment AFTER it answers ok — what was queued right behind it was wiped (12 Oct: two
      // tracks asked, one in the queue). So after the first: wait until Roon plays or loads it (at most 5 s).
      if (p === 0 && i === 0 && order.length > 1) {
        const first = String(field(order[0], 'Title') ?? '');
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const off = officialZone(z.name);
          if ((off?.state === 'playing' || off?.state === 'loading') && String(off.now_playing?.three_line?.line1 ?? off.now_playing?.one_line?.line1 ?? '').includes(first)) break;
          await wait(150);
        }
        await wait(300);
      }
    }
    log(`play_tracks (${how}): ${done} tracks on ${z.name}`);
    // Read the queue back: are they all there?
    let queued: number | undefined;
    const q = obj(c, field(c.graph.getObject(z.oid), 'Queue'));
    if (q) { await wait(600); const rr = await c.call('Queue', 'GetItems', [{ type: 'ResultCallback<IList<TransportItem>>', name: 'cb_result' }], Buffer.alloc(0), q.oid).catch(() => null);
      if (rr?.success && rr.payload.length > 1) { const br = new BinaryReader(Uint8Array.from(rr.payload)); br.integer(); const total = br.flexInt();
        const at = Math.max(0, field(c.graph.getObject(q.oid), 'CurrentItemIndex') ?? 0); queued = Math.max(0, total - at); } }
    return { zone: z.name, how, count: done, titles: tracks.map((t) => field(t, 'Title')), in_queue: queued,
             note: p === 0 && queued !== undefined && queued < done ? `Roon has ${queued} of the ${done} in the queue` : undefined };
  });
  return { ok: true, ...r, ...(await started(r.zone, p)) };
}

const BUTTONS: Record<string, 'Pause' | 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'> =
  { pause: 'Pause', play: 'Play', playpause: 'PlayPause', stop: 'Stop', next: 'Next', previous: 'Previous' };
export async function control(zoneName: string, action: string) {
  // release: Zone::Suspend — what Roon does by itself a few seconds after a pause: the zone lets go of its device at once,
  // so another source can have it (a speaker that holds on to Roon's session otherwise stays Roon's for a while).
  if (action === 'release') {
    return withCore(async (c) => {
      const z = findZone(c, zoneName);
      c.remoting.callMethodNoReply(z.oid, formatMethodSignature('Zone', 'Suspend', []), Buffer.alloc(0));
      log(`control: Suspend on ${z.name}`);
      return { ok: true, zone: z.name, action };
    });
  }
  const m = BUTTONS[action];
  if (!m) throw new RoonError(`Unknown action; choose from ${Object.keys(BUTTONS).join(', ')}`, 'invalid');
  const r = await withCore(async (c) => {
    const z = findZone(c, zoneName);
    c.zoneControl(z.oid, m);   // no answer: Roon carries it out or not
    log(`control: ${m} on ${z.name}`);
    return { zone: z.name };
  });
  // Roon gives no answer to a button and changes the state a moment later: wait (at most 3 s) until it shows, and say it.
  const expect: Record<string, string[]> = { pause: ['paused'], stop: ['stopped', 'paused'], play: ['playing', 'loading'] };
  let state = officialZone(r.zone)?.state;
  if (expect[action]) {
    const end = Date.now() + 3000;
    while (Date.now() < end && !expect[action].includes(state ?? '')) { await wait(150); state = officialZone(r.zone)?.state; }
  }
  return { ok: !expect[action] || expect[action].includes(state ?? ''), zone: r.zone, action, state };
}

export async function seek(zoneName: string, seconds: number) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const res = await c.call('Zone', 'Seek', [{ type: 'int', name: 'seconds' }, { type: 'ResultCallback', name: 'cb_done' }], buildArgs([Arg.int(Math.max(0, Math.round(seconds)))]), z.oid);
    if (!res.success) throw new RoonError(`Roon refused to seek (${res.status})`);
    return { ok: true, zone: z.name, position: duration(seconds) };
  });
}

/** Shuffle, repeat and Roon Radio for the queue that's there (Zone::SetShuffle, SetLoop, SetAutoSwim, AutoSwimNow). */
export async function settings(zoneName: string, s: { shuffle?: boolean; repeat?: 'off' | 'all' | 'one'; roon_radio?: boolean | 'now' }) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const send = (method: string, params: { type: string; name: string }[], args: Buffer) => c.remoting.callMethodNoReply(z.oid, formatMethodSignature('Zone', method, params), args);
    const done: Any = {};
    if (s.shuffle !== undefined) { send('SetShuffle', [{ type: 'bool', name: 'shuffle' }], buildArgs([Arg.bool(s.shuffle)])); done.shuffle = s.shuffle; }
    if (s.repeat !== undefined) { send('SetLoop', [{ type: 'LoopMode', name: 'loop' }], buildArgs([Arg.enum_({ off: 0, all: 1, one: 2 }[s.repeat])])); done.repeat = s.repeat; }
    if (s.roon_radio === 'now') { send('AutoSwimNow', [], Buffer.alloc(0)); done.roon_radio = 'now'; }
    else if (s.roon_radio !== undefined) { send('SetAutoSwim', [{ type: 'bool', name: 'autoswim' }], buildArgs([Arg.bool(s.roon_radio)])); done.roon_radio = s.roon_radio; }
    if (!Object.keys(done).length) throw new RoonError('Nothing to set: give shuffle, repeat or roon_radio', 'invalid');
    log(`settings: ${z.name} ← ${JSON.stringify(done)}`);
    return { ok: true, zone: z.name, ...done };
  });
}

// ---- the queue ----
function queueOf(c: C, zoneName: string) {
  const z = findZone(c, zoneName);
  const q = obj(c, field(c.graph.getObject(z.oid), 'Queue'));
  if (!q) throw new RoonError(`${z.name} has no queue`, 'invalid');
  return { z, q };
}
/** Queue::GetItems gives the whole queue (also what has played) as references; the needle is CurrentItemIndex. */
async function queueItems(c: C, q: Any): Promise<bigint[]> {
  const res = await c.call('Queue', 'GetItems', [{ type: 'ResultCallback<IList<TransportItem>>', name: 'cb_result' }], Buffer.alloc(0), q.oid);
  if (!res.success) throw new RoonError(`Roon refused the queue (${res.status})`);
  if (res.payload.length < 2) return [];
  const r = new BinaryReader(Uint8Array.from(res.payload));
  r.integer(); const n = r.flexInt(); const refs: bigint[] = [];
  for (let i = 0; i < n && r.remaining > 0; i++) refs.push(r.flexLong());
  return refs;
}
function queueRow(c: C, oid: bigint): Any {
  const tr = obj(c, field(items(c, field(c.graph.getObject(oid), 'Tracks'))[0], 'Track'));
  const al = obj(c, field(tr, 'Album'));
  const r: Any = { title: field(tr, 'Title') ?? null, artist: clean(field(al, 'PerformedBy') ?? '') };
  trackArtist(c, r, tr, al);
  const album = field(al, 'Title'); if (album) r.album = album;
  const l = field(tr, 'LengthSeconds'); if (typeof l === 'number') r.length = duration(l);
  const k = field(tr, 'TrackId'); if (k !== undefined && k !== null) r.key = String(k);
  const img = imageKey(c, al) ?? imageKey(c, tr); if (img) r.image = img;
  return r;
}
/** The queue item at position n (1 = what plays now, as roon_queue numbers them). */
async function queueItemAt(c: C, zoneName: string, n: number) {
  const { z, q } = queueOf(c, zoneName);
  const refs = await queueItems(c, q);
  const at = Math.max(0, field(c.graph.getObject(q.oid), 'CurrentItemIndex') ?? 0);
  const oid = refs[at + n - 1];
  if (oid === undefined) throw new RoonError(`The queue of ${z.name} has no item ${n} (${Math.max(0, refs.length - at)} from here)`, 'invalid');
  return { z, q, oid, refs, at };
}
/** Jump to an item of the queue (Queue::PlayFromHere): it plays, what came before it is done. */
export async function queueJump(zoneName: string, n: number) {
  const r = await withCore(async (c) => {
    const { z, q, oid } = await queueItemAt(c, zoneName, n);
    c.remoting.callMethodNoReply(q.oid, formatMethodSignature('Queue', 'PlayFromHere', [{ type: 'TransportItem', name: 'item' }]), buildArgs([Arg.ref(oid)]));
    log(`queue_jump: ${z.name} → item ${n}`);
    return { zone: z.name, n };
  });
  return { ok: true, ...r, ...(await started(r.zone, PRIORITY['now'])) };
}
/** Take items out of the queue (Queue::RemoveItems), by their positions from roon_queue. */
export async function queueRemove(zoneName: string, ns: number[]) {
  return withCore(async (c) => {
    const { z, q } = queueOf(c, zoneName);
    const refs = await queueItems(c, q);
    const at = Math.max(0, field(c.graph.getObject(q.oid), 'CurrentItemIndex') ?? 0);
    const oids = [...new Set(ns)].map((n) => refs[at + n - 1]).filter((o): o is bigint => o !== undefined);
    if (!oids.length) throw new RoonError('No such items in the queue', 'invalid');
    c.remoting.callMethodNoReply(q.oid, formatMethodSignature('Queue', 'RemoveItems', [{ type: 'IEnumerable<TransportItem>', name: 'items' }]), buildArgs([Arg.collection(oids.map((o) => buildArgs([Arg.ref(o)])))]));
    log(`queue_remove: ${z.name} − ${oids.length} item(s)`);
    await wait(300);
    const after = await queueItems(c, q);
    return { ok: true, zone: z.name, removed: oids.length, left: Math.max(0, after.length - at) };
  });
}
/** Move an item of the queue next to another (Queue::MoveItems): `n` goes before or after `to` (positions from roon_queue).
 *  InsertionPoint, measured 13 Oct 2026 on the Mu-so's queue: 0 = the start (before what plays — the item leaves the
 *  view), 1 = the end, 2 = after the relative item, 3 = before it. */
const INSERTION = { before: 3, after: 2 };
export async function queueMove(zoneName: string, n: number, to: number, where: 'before' | 'after') {
  return withCore(async (c) => {
    const { z, q, oid, refs, at } = await queueItemAt(c, zoneName, n);
    const rel = refs[at + to - 1];
    if (rel === undefined || to === n) throw new RoonError(`The queue of ${z.name} has no item ${to} to move next to`, 'invalid');
    const point = INSERTION[where];
    const res = await c.call('Queue', 'MoveItems',
      [{ type: 'IEnumerable<TransportItem>', name: 'items' }, { type: 'InsertionPoint', name: 'insertionpoint' }, { type: 'TransportItem', name: 'relative_to_item' }, { type: 'ResultCallback', name: 'cb_done' }],
      Buffer.concat([buildArgs([Arg.collection([buildArgs([Arg.ref(oid)])]), Arg.enum_(point), Arg.ref(rel)])]), q.oid);
    if (!res.success) throw new RoonError(`Roon refused to move the item (${res.status})`);
    log(`queue_move: ${z.name} item ${n} → ${where} ${to} (point ${point})`);
    await wait(300);
    const after = await queueItems(c, q);
    const now = after.indexOf(oid) - at + 1;
    return { ok: true, zone: z.name, moved: n, now_at: now > 0 ? now : undefined };
  });
}
export async function queue(zoneName: string, limit: number) {
  return withCore(async (c) => {
    const { z, q } = queueOf(c, zoneName);
    const refs = await queueItems(c, q);
    const at = Math.max(0, field(c.graph.getObject(q.oid), 'CurrentItemIndex') ?? 0);
    const view = refs.slice(at, at + Math.min(Math.max(1, limit), 200));
    const end = Date.now() + 2500;   // the items arrive after the answer
    while (Date.now() < end && view.some((oid) => queueRow(c, oid).title === null)) await wait(50);
    return { zone: z.name, left: Math.max(0, refs.length - at), rows: view.map((oid, i) => ({ n: i + 1, now: i === 0 || undefined, ...queueRow(c, oid) })) };
  });
}
/** Clears what comes after the playing track (Queue::RemoveItems); `everything` clears the whole queue (RemoveAll). */
export async function queueClear(zoneName: string, everything: boolean) {
  return withCore(async (c) => {
    const { z, q } = queueOf(c, zoneName);
    if (everything) {
      c.remoting.callMethodNoReply(q.oid, 'Sooloos.Broker.Api.Queue::RemoveAll()', Buffer.alloc(0));
      return { ok: true, zone: z.name, removed: 'everything' };
    }
    const refs = await queueItems(c, q);
    const at = Math.max(0, field(c.graph.getObject(q.oid), 'CurrentItemIndex') ?? 0);
    const after = refs.slice(at + 1);
    if (after.length) c.remoting.callMethodNoReply(q.oid, 'Sooloos.Broker.Api.Queue::RemoveItems(System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.TransportItem>)',
      buildArgs([Arg.collection(after.map((oid) => buildArgs([Arg.ref(oid)])))]));
    return { ok: true, zone: z.name, removed: after.length };
  });
}

// ---- grouping and transfer ----
export const outputsOf = (c: C, zone: bigint) => c.graph.findByType('Endpoint').filter((e) => { const z = field(e, 'Zone'); return isRef(z) && String(z.$ref) === String(zone) && typeof field(e, 'Name') === 'string'; });

/** Transport::LinkEndpoints(Zone, IEnumerable<Endpoint>): the main zone keeps its music; the list is its own outputs
 *  plus the ones joining. Roon only groups outputs of the same kind (LinkCandidates). */
export async function group(main: string, join: string[]) {
  return withCore(async (c) => {
    const h = findZone(c, main);
    const own = outputsOf(c, h.oid);
    const added: Any[] = [];
    for (const n of join) { const z = findZone(c, n); if (z.oid === h.oid) continue; for (const e of outputsOf(c, z.oid)) if (!added.some((x) => x.oid === e.oid)) added.push(e); }
    if (!added.length) throw new RoonError('Nothing to group: name at least one other zone', 'invalid');
    for (const e of added) {
      const can = (obj(c, field(own[0], 'LinkCandidates'))?.fields?.$items ?? []).some((x: Any) => isRef(x) && String(x.$ref) === String(e.oid));
      if (!can) throw new RoonError(`${field(e, 'Name')} can't be grouped with ${h.name} (Roon groups only outputs of the same kind)`, 'invalid');
    }
    const res = await c.call('Transport', 'LinkEndpoints', [{ type: 'Zone', name: 'zone' }, { type: 'IEnumerable<Endpoint>', name: 'endpoints' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.ref(h.oid), Arg.collection([...own, ...added].map((e) => buildArgs([Arg.ref(e.oid)])))]), c.serviceOid('Transport'));
    if (!res.success) throw new RoonError(`Roon refused to group (${res.status})`);
    return { ok: true, group: [...own, ...added].map((e) => field(e, 'Name')) };
  });
}
export async function ungroup(zoneName: string, only?: string) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const all = outputsOf(c, z.oid);
    if (all.length < 2) throw new RoonError(`${z.name} isn't in a group`, 'invalid');
    const off = only ? all.filter((e) => String(field(e, 'Name')).toLowerCase().includes(only.toLowerCase())) : all;
    if (!off.length) throw new RoonError(`"${only}" isn't in this group (${all.map((e) => field(e, 'Name')).join(' + ')})`, 'not_found');
    const res = await c.call('Transport', 'UnlinkEndpoints', [{ type: 'IEnumerable<Endpoint>', name: 'endpoints' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.collection(off.map((e) => buildArgs([Arg.ref(e.oid)])))]), c.serviceOid('Transport'));
    if (!res.success) throw new RoonError(`Roon refused to ungroup (${res.status})`);
    return { ok: true, released: off.map((e) => field(e, 'Name')) };
  });
}
/** What plays, with its queue, to another zone (Transport::Transfer — Roon's own "Transfer zone"). */
export async function transfer(from: string, to: string) {
  return withCore(async (c) => {
    const a = findZone(c, from), b = findZone(c, to);
    if (a.oid === b.oid) throw new RoonError('From and to are the same zone', 'invalid');
    const res = await c.call('Transport', 'Transfer', [{ type: 'Zone', name: 'from' }, { type: 'Zone', name: 'to' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.ref(a.oid), Arg.ref(b.oid)]), c.serviceOid('Transport'));
    if (!res.success) throw new RoonError(`Roon refused the transfer (${res.status})`);
    return { ok: true, from: a.name, to: b.name };
  });
}

// ---- sleep timer and standby ----
export async function sleep(zoneName: string, minutes: number | null) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const on = minutes !== null;
    const args = new BinaryWriter().optionalBoolean(on).boolean(on);
    if (on) args.integer(minutes!);
    const res = await c.call('Zone', 'SetSleepTimer', [{ type: 'bool?', name: 'is_enabled' }, { type: 'int?', name: 'duration_minutes' }, { type: 'ResultCallback', name: 'cb_result' }], args.toBuffer(), z.oid);
    if (!res.success) throw new RoonError(`Roon refused the sleep timer (${res.status})`);
    return { ok: true, zone: z.name, ...(on ? { minutes } : { off: true }) };
  });
}
export async function standby(zoneName: string, on: boolean) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const outs = outputsOf(c, z.oid).filter((e) => field(e, 'SupportsStandby') === true);
    if (!outs.length) throw new RoonError(`${z.name} has no standby`, 'invalid');
    for (const e of outs) { if (on) c.standby(e.oid); else await short(c.powerOn(e.oid), 6000); }
    return { ok: true, zone: z.name, standby: on };
  });
}

// ---- the cover ----
/** The cover of what plays in a zone, from the Core (GET :9330/api/image/<key>, no pairing needed). */
export async function cover(zoneName?: string) {
  const t = await findTarget();
  const info = await withCore(async (c) => {
    const pick = zoneName ? findZone(c, zoneName) : null;
    const zones = c.graph.findByType('Zone');
    const z = pick ? c.graph.getObject(pick.oid)
      : zones.find((x) => (field(x, 'State') ?? 0) === 0 && items(c, field(obj(c, field(x, 'NowPlaying')), 'Tracks')).length)
        ?? zones.find((x) => field(x, 'State') === 2 && items(c, field(obj(c, field(x, 'NowPlaying')), 'Tracks')).length);
    if (!z) throw new RoonError(zoneName ? `Nothing plays on ${zoneName}` : 'Nothing plays in Roon right now', 'not_found');
    const tr = obj(c, field(items(c, field(obj(c, field(z, 'NowPlaying')), 'Tracks'))[0], 'Track'));
    const al = obj(c, field(tr, 'Album'));
    const url = String(field(obj(c, field(al, 'Image')), 'Url') ?? field(obj(c, field(tr, 'Image')), 'Url') ?? '');
    const key = /^broker:\/\/\/image\/([^.]+)\./.exec(url)?.[1];
    return { key, title: field(tr, 'Title'), album: field(al, 'Title'), artist: clean(field(al, 'PerformedBy')), zone: pick?.name ?? zoneNames(c).get(String(z.oid)) };
  });
  const off = info.zone ? officialZone(info.zone) : undefined;
  // The graph's key is an internal one: the Core serves it on /image/<key>.jpg, not on /api/image/, which takes the official
  // API's keys only (5 Nov 2026, forum report: roon_cover failed whenever the internal protocol was on). The official key first.
  const urls = [off?.now_playing?.image_key && `/api/image/${off.now_playing.image_key}?scale=fit&width=600&height=600`,
                info.key && `/image/${info.key}.jpg?scale=fit&width=600&height=600`].filter(Boolean) as string[];
  // A stream into Roon (audio input, radio): no track in the graph — the lines Roon shows instead.
  const lines = off?.now_playing?.three_line;
  if (!info.title && lines?.line1) { info.title = lines.line1; info.artist = lines.line2 ?? ''; info.album = lines.line3; }
  if (!urls.length) throw new RoonError('Roon has no cover for what plays', 'not_found');
  let r: Response | null = null;
  for (const u of urls) {
    r = await fetch(`http://${t.host}:${t.port}${u}`).catch(() => null);
    if (r?.ok) break;
    log(`cover: ${u.split('?')[0]} → ${r ? r.status : 'no answer'}`);
  }
  if (!r?.ok) throw new RoonError('Roon doesn\'t hand over the cover right now', 'unavailable');
  return { info: { zone: info.zone, title: info.title, album: info.album, artist: info.artist },
           image: { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: r.headers.get('content-type') ?? 'image/jpeg' } };
}
