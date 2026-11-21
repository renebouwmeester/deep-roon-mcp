// Roon's zones as the internal protocol knows them, and what plays in each.
import { isRef } from '../intern';
import { withCore, RoonError } from '../core/session';
import { officialReady, officialZone } from '../core/official';
import { Any, C, clean, dotnetDate, duration, field, imageKey, items, localTime, obj, trackArtist } from './graph';
import { fullAlbum } from './library';
import { pickByName } from '../core/namematch';

/** The outputs there are now: per name only the current one. A Squeezebox player that reconnects leaves its old output
 *  in the graph; prefer an output whose zone has a track, then one that plays or pauses, then the newest. */
export function currentEndpoints(c: C): Any[] {
  const score = (e: Any) => {
    const z = obj(c, field(e, 'Zone'));
    const hasTrack = items(c, field(obj(c, field(z, 'NowPlaying')), 'Tracks')).length > 0;
    const state = field(z, 'State') ?? 0;     // 0 playing, 1 loading, 2 paused, 3 stopped
    return (hasTrack ? 4 : 0) + (state !== 3 ? 2 : 0);
  };
  const byName = new Map<string, Any>();
  for (const e of c.graph.findByType('Endpoint')) {
    const n = field(e, 'Name'); if (typeof n !== 'string') continue;
    const was = byName.get(n);
    if (!was) { byName.set(n, e); continue; }
    const a = score(e), b = score(was);
    if (a > b || (a === b && Number(e.oid) > Number(was.oid))) byName.set(n, e);
  }
  return [...byName.values()];
}

/** The name per zone: its output, or for a group the outputs together ("Kitchen + Living Room"). */
export function zoneNames(c: C): Map<string, string> {
  const per = new Map<string, string[]>();
  for (const e of currentEndpoints(c)) { const z = field(e, 'Zone'), n = field(e, 'Name'); if (isRef(z) && typeof n === 'string') per.set(String(z.$ref), [...(per.get(String(z.$ref)) ?? []), n]); }
  return new Map([...per].map(([k, v]) => [k, v.join(' + ')]));
}

/** A zone by (part of) its name. */
export function findZone(c: C, name: string): { name: string; oid: bigint } {
  const zones = [...zoneNames(c)].map(([oid, n]) => ({ name: n, oid: BigInt(oid) }));
  const z = pickByName(zones, name, (x) => x.name);
  if (!z) throw new RoonError(`No Roon zone called "${name}"; Roon has: ${zones.map((x) => x.name).join(', ')}`, 'not_found');
  return z;
}

export async function zones() {
  return withCore(async (c) => {
    const names = zoneNames(c);
    return { zones: [...new Set(currentEndpoints(c).map((e) => field(e, 'Name')).filter((n) => typeof n === 'string'))].sort(),
             groups: [...names.values()].filter((n) => n.includes(' + ')).map((n) => n.split(' + ')) };
  });
}

const STATE: Record<number, string> = { 0: 'playing', 1: 'loading', 2: 'paused', 3: 'stopped' };   // ZoneState; an absent field is 0
const REPEAT: Record<number, string> = { 1: 'all', 2: 'one' };                                      // LoopMode: Disabled, Loop, LoopOne

/** Disc covers per album (AlbumId → disc number → image key), so a box set costs one GetAlbum per half hour. */
const discCovers = new Map<string, { at: number; covers: Map<number, string> }>();
const DISC_COVERS_TTL_MS = 30 * 60 * 1000;

/** The disc a track is on, for an album of more than one disc: number, count, title (Roon's disc title, e.g. "Sessions
 *  and Demos") and, since Roon 2.7x's per-disc artwork, the disc's own cover as `image` (21 Nov 2026: a four-disc box
 *  set with a cover per disc; the zone feed's image stays the album's main cover). */
async function discOf(c: C, tr: Any, al: Any): Promise<Any> {
  const number = field(tr, 'MediaNumber');
  const count = field(al, 'MediaCount') ?? field(al, 'MaxMediaNumber');
  const title = field(tr, 'MediaTitle');
  if (typeof number !== 'number' || !((typeof count === 'number' && count > 1) || number > 1 || title)) return undefined;
  const d: Any = { number };
  if (typeof count === 'number') d.of = count;
  if (typeof title === 'string' && title) d.title = title;
  const id = String(field(al, 'AlbumId') ?? al?.oid ?? '');
  let known = discCovers.get(id);
  if (!known || Date.now() - known.at > DISC_COVERS_TTL_MS) {
    const covers = new Map<number, string>();
    const full = await fullAlbum(c, al).catch(() => null);
    const fa = obj(c, full);
    for (const disc of items(c, field(fa, 'Discs'))) {
      const n = field(disc, 'MediaNumber'), key = imageKey(c, disc);
      if (typeof n === 'number' && key) covers.set(n, key);
    }
    if (full) { known = { at: Date.now(), covers }; discCovers.set(id, known); if (discCovers.size > 100) discCovers.delete(discCovers.keys().next().value!); }
  }
  const image = known?.covers.get(number); if (image) d.image = image;
  return d;
}

/** What plays per zone: state, track, album, artist, format, position. */
export async function nowPlaying() {
  await officialReady().catch(() => {});
  return withCore(async (c) => {
    const names = zoneNames(c);
    // Only zones with an output: after a transfer the old zone objects stay in the graph.
    const out = await Promise.all(c.graph.findByType('Zone').filter((z) => names.has(String(z.oid))).map(async (z) => {
      const r: Any = { zone: names.get(String(z.oid)), state: STATE[field(z, 'State') ?? 0] ?? String(field(z, 'State')) };
      // The volume, from the official API (the internal graph doesn't carry it).
      const off = officialZone(r.zone);
      // The state from the official API when it's there: the graph lags a moment behind (a pause read back at once still
      // said "playing", 12 Oct).
      if (off?.state) r.state = off.state;
      const v = off?.outputs.find((o) => o.volume)?.volume;
      if (v) { r.volume = v.value; r.volume_max = v.max; if (v.is_muted) r.muted = true; }
      const img = off?.now_playing?.image_key; if (img) r.image = img;   // the cover's key (:9330/api/image/<key>)
      const outs = c.graph.findByType('Endpoint').filter((e) => { const zz = field(e, 'Zone'); return isRef(zz) && String(zz.$ref) === String(z.oid); });
      if (outs.some((e) => field(e, 'IsStandby') === true)) r.standby = true;
      if (field(z, 'Shuffle') === true) r.shuffle = true;
      const loop = REPEAT[field(z, 'Loop') ?? 0]; if (loop) r.repeat = loop;
      if (field(z, 'AutoSwim') === true) r.roon_radio = true;
      if (field(z, 'IsSleepTimerEnabled') === true) r.sleep_timer = { minutes: field(z, 'SleepTimerDurationMinutes') ?? undefined, until: localTime(dotnetDate(field(z, 'SleepTimerExpiration'))) };
      if (r.state === 'stopped') return r;            // what still "stands" in a stopped zone is old news
      const np = obj(c, field(z, 'NowPlaying'));
      const tr = obj(c, field(items(c, field(np, 'Tracks'))[0], 'Track'));
      // During a stream through Roon's audio input the graph can still hold the last track of Roon's own queue (12 Oct
      // 2026: "Supreme" in the graph while Basso played "People Like You" into the zone): when the official lines name
      // something else than the graph's track, the official lines win.
      const lines = off?.now_playing?.three_line;
      const t = String(field(tr, 'Title') ?? '').toLowerCase(), l1 = String(lines?.line1 ?? '').toLowerCase();
      const stream = !!l1 && !!t && !l1.includes(t) && !t.includes(l1);
      if (tr && field(tr, 'Title') && !stream) {
        const al = obj(c, field(tr, 'Album'));
        r.title = field(tr, 'Title'); r.artist = clean(field(al, 'PerformedBy')); r.album = field(al, 'Title');
        trackArtist(c, r, tr, al);
        const tk = field(tr, 'TrackId'); if (tk !== undefined && tk !== null) r.track_key = String(tk);   // keys, for roon_album and a client that opens the album
        const ak = field(al, 'AlbumId'); if (ak !== undefined && ak !== null) r.album_key = String(ak);
        const f = field(tr, 'Format'); if (f) r.format = f;
        const l = field(tr, 'LengthSeconds'); if (typeof l === 'number') r.length = duration(l);
        const disc = await discOf(c, tr, al); if (disc) r.disc = disc;
      } else {
        // A stream through Roon's audio input (another app feeding Roon) or a radio station: no track in the graph, but
        // the official API has the lines Roon shows.
        if (lines?.line1) { r.title = lines.line1; if (lines.line2) r.artist = lines.line2; if (lines.line3) r.album = lines.line3; r.source = 'a stream into Roon (audio input or radio)'; }
        else r.line = 'a stream Roon receives from elsewhere (no track details)';
      }
      const pos = field(z, 'SeekPosition'); if (typeof pos === 'number') r.position = duration(pos);
      const left = field(obj(c, field(z, 'Queue')), 'TrackCountRemaining'); if (typeof left === 'number' && !r.source) r.tracks_left_in_queue = left;
      return r;
    }));
    return { zones: out };
  });
}

/** The ints of a DataList<int>: an object in the graph with `$items`, the items by value, or a length list in a buffer. */
function ints(c: C, v: Any): number[] | null {
  const o = obj(c, v);
  const list = o?.fields?.$items ?? o?.$items ?? (Array.isArray(o) ? o : null);
  if (Array.isArray(list)) return list.map(Number).filter((n) => Number.isFinite(n));
  return null;
}

/** Per zone the track and the waveform it last had: right after a track change the zone still carries the previous
 *  track's waveform (measured 22 Oct 2026: at 0:07 of "Go Your Own Way" the numbers of the track before; at 0:28 its own,
 *  whole). The same numbers under another track are the old ones. */
const lastWave = new Map<string, { track: string; sig: string }>();

/** The waveform of what plays in a zone (Zone.WaveformData, 22 Oct 2026 — asked for on the Roon forum). Roon draws it
 *  in its seek bar: for a local file from its own analysis, for a stream from the first time it played (then stored).
 *  `points` buckets it to a length a client can draw; `raw` returns the values as the Core sends them. */
export async function waveform(zone: string, points = 100, raw = false) {
  return withCore(async (c) => {
    const zn = findZone(c, zone);
    const z = c.graph.getObject(zn.oid);
    const v = field(z, 'WaveformData');
    const vals = ints(c, v);
    const np = obj(c, field(z, 'NowPlaying'));
    const tr = obj(c, field(items(c, field(np, 'Tracks'))[0], 'Track'));
    const r: Any = { zone: zn.name };
    if (field(tr, 'Title')) r.title = field(tr, 'Title');
    if (raw) {
      r.shape = v === undefined ? 'absent' : isRef(v) ? 'ref' : Buffer.isBuffer(v) ? `buffer ${v.length}` : typeof v;
      if (Buffer.isBuffer(v)) r.bytes = [...v.subarray(0, 64)];
      if (isRef(v)) r.object = Object.keys(obj(c, v)?.fields ?? {});
      if (vals) { r.count = vals.length; r.values = vals; }
      return r;
    }
    const none = 'No waveform for this track yet: Roon makes one for a stream the first time it plays (within half a minute or so), and for a local file when it has analysed it.';
    if (!vals?.length) { r.waveform = null; r.note = none; return r; }
    const track = String(field(tr, 'TrackId') ?? field(tr, 'Title') ?? ''), sig = vals.join(','), was = lastWave.get(String(zn.oid));
    if (was && was.track !== track && was.sig === sig) { r.waveform = null; r.note = none; return r; }
    lastWave.set(String(zn.oid), { track, sig });
    // Measured 22 Oct 2026: 2000 values of 0–255, in pairs (the top and bottom of the bar, so far always equal) — 1000
    // steps over the track. One value per pair (the larger), on Roon's own scale; a bucket shows its mean (the peak
    // made a loud master one flat bar of ones).
    const steps = Array.from({ length: Math.floor(vals.length / 2) }, (_, i) => Math.max(vals[2 * i], vals[2 * i + 1]));
    const n = Math.max(1, Math.min(points, steps.length)), per = steps.length / n;
    r.points = n;
    r.waveform = Array.from({ length: n }, (_, i) => {
      let som = 0, k = 0; for (let j = Math.floor(i * per); j < Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1); j++) { som += steps[j]; k++; }
      return Math.round((som / k / 255) * 100) / 100;
    });
    const pos = field(z, 'SeekPosition'); if (typeof pos === 'number') r.position = duration(pos);
    const l = field(tr, 'LengthSeconds'); if (typeof l === 'number') r.length = duration(l);
    return r;
  });
}
