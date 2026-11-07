// Playlists, favourites, Listen Later, adding to the library, other versions and "more like this", Roon's signal path,
// and MUSE (Roon's DSP). The tools that change something read the state back afterwards where they can: the Core
// sometimes does nothing, silently, instead of answering with an error.
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { BinaryWriter } from '../intern/proto/writer';
import { formatMethodSignature } from '../intern/catalog/signature';
import { withCore, fresh, RoonError } from '../core/session';
import { officialZone } from '../core/official';
import { log } from '../core/log';
import { Any, C, albumRow, clean, dotnetDate, duration, field, flag, imageKeys, items, localTime, obj, resultRow, short, untilField, untilLoaded, wait, imageKey, trackArtist } from './graph';
import { findAlbum, findTracks, fullAlbum, performer, shelf, streaming } from './library';
import * as tidal from './tidal';
import { playlistKey } from './tidal';
import { currentEndpoints, findZone, zoneNames } from './zones';
import { How, PRIORITY, outputsOf, playParams, started } from './control';

const profileObject = (c: C) => {
  const p = [...c.graph.objects.values()].find((o) => o.typeName.endsWith('.Profile'));
  if (!p) throw new RoonError('Roon gave no profile');
  return p;
};
const decoded = (c: C, payload: Buffer) => (payload.length ? c.graph.decodeReturnValue(Uint8Array.from(payload)) : null);

// ---- playlists ----
const PLAYLIST_KIND: Record<number, string> = { 1: 'itunes', 5: 'roon', 6: 'roon (read-only)', 10: 'TIDAL', 11: 'file', 12: 'qobuz', 13: 'roon editorial', 15: 'smart' };
export function allPlaylists(c: C) {
  const service = c.graph.findByType('Playlists')[0];
  if (!service) throw new RoonError('Roon gives no playlists service', 'unavailable');
  return { service, list: items(c, field(service, 'AllPlaylists')) };
}
/** A playlist by key or exact name: one of Roon's playlists, else a TIDAL playlist from roon_tidal_playlists. */
async function findPlaylist(c: C, key: string) {
  const { list } = allPlaylists(c);
  const p = list.find((x) => playlistKey(x) === key) ?? list.find((x) => String(field(x, 'Name') ?? '').toLowerCase() === key.toLowerCase())
    ?? await tidal.findPlaylist(c, key);
  if (!p) throw new RoonError('Unknown playlist — read roon_playlists (or roon_tidal_playlists) for the keys', 'not_found');
  return p;
}
export async function playlists() {
  return withCore(async (c) => ({ playlists: allPlaylists(c).list.map((p) => {
    const r: Any = { key: playlistKey(p), name: field(p, 'Name') ?? '', kind: PLAYLIST_KIND[field(p, 'Type')] ?? String(field(p, 'Type') ?? ''),
      tracks: field(p, 'TrackCount') ?? field(p, 'ItemCount') ?? undefined, read_only: field(p, 'IsReadOnly') === true || undefined };
    // For a tile (13 Oct 2026): the covers Roon shows on the playlist, its length, a few of its artists and its description.
    const imgs = imageKeys(c, p); if (imgs.length) r.images = imgs;
    const l = field(p, 'LengthSeconds'); if (typeof l === 'number' && l > 0) r.length = duration(l);
    const names = (obj(c, field(p, 'SampleArtistNames'))?.fields?.$items ?? []).filter((x: Any) => typeof x === 'string').slice(0, 4); if (names.length) r.artists = names;
    const d = field(p, 'Description'); if (d) r.description = clean(d).replace(/\s+/g, ' ').slice(0, 240);
    return r;
  }) }));
}
export async function playlist(key: string, limit: number) {
  return withCore(async (c) => {
    const p = await findPlaylist(c, key);
    const res = await c.call('Playlist', 'GetItems', [{ type: 'ResultCallback<Query<PlaylistItem>>', name: 'cb_result' }], Buffer.alloc(0), p.oid);
    if (!res.success) throw new RoonError(`Roon refused the playlist (${res.status})`);
    const v = decoded(c, res.payload);
    const n = Math.min(Math.max(1, limit), 300);
    const end = Date.now() + 3000; let list: Any[] = [];
    while (Date.now() < end) {
      list = ((isRef(v) ? (c.graph.getObject(v.$ref) as Any)?.fields?.$items : null) ?? []) as Any[];
      if (list.length && list.slice(0, n).every((x) => field(obj(c, field(obj(c, x), 'Track')), 'Title') !== undefined)) break;
      await wait(60);
    }
    return { name: field(p, 'Name'), total: list.length, rows: list.slice(0, n).map((x, i) => {
      const tr = obj(c, field(obj(c, x), 'Track')); const al = obj(c, field(tr, 'Album'));
      const r: Any = { n: i + 1, key: String(field(tr, 'TrackId') ?? ''), title: field(tr, 'Title') ?? null, artist: clean(field(al, 'PerformedBy') ?? ''), album: field(al, 'Title') ?? undefined };
      trackArtist(c, r, tr, al);
      // For a playlist page (13 Oct 2026): the album's key and cover, and the length.
      const ak = field(al, 'AlbumId'); if (ak !== undefined && ak !== null) r.album_key = String(ak);
      const im = imageKey(c, al); if (im) r.image = im;
      const l = field(tr, 'LengthSeconds'); if (typeof l === 'number' && l > 0) r.length = duration(l);
      return r;
    }) };
  });
}
export async function playPlaylist(key: string, zoneName: string, how: How, shuffle: boolean) {
  const p = PRIORITY[how];
  const r = await withCore(async (c) => {
    const pl = await findPlaylist(c, key); const z = findZone(c, zoneName);
    const args = Buffer.concat([buildArgs([Arg.ref(z.oid), Arg.sooid(c.profile())]), playParams(c, p, shuffle), buildArgs([Arg.ref(pl.oid), Arg.ref(0n)])]);
    const res = await c.call('Transport', 'PlayPlaylist',
      [{ type: 'Zone', name: 'zone' }, { type: 'Sooid', name: 'profileid' }, { type: 'PlayParameters', name: 'parameters' }, { type: 'Playlist', name: 'playlist' },
       { type: 'PlaylistItem', name: 'from_playlist_item' }, { type: 'ResultCallback<PlayFeedback>', name: 'cb_result' }], args, c.serviceOid('Transport'));
    log(`play_playlist (${how}${shuffle ? ', shuffled' : ''}): ${field(pl, 'Name')} on ${z.name} → ${res.success ? 'ok' : res.status}`);
    if (!res.success) throw new RoonError(`Roon refused to play the playlist (${res.status})`);
    return { zone: z.name, how, shuffle: shuffle || undefined, name: field(pl, 'Name') };
  });
  return { ok: true, ...r, ...(await started(r.zone, p)) };
}
/** A new playlist of tracks (Playlists::CreatePlaylistFromMediaIds), then read back: is it there, with how many tracks. */
export async function playlistCreate(name: string, keys: string[]) {
  return withCore(async (c) => {
    const { service } = allPlaylists(c);
    await findTracks(c, keys);    // do they exist? (an unknown key is an error, not half a playlist)
    const res = await c.call('Playlists', 'CreatePlaylistFromMediaIds',
      [{ type: 'Profile', name: 'profile' }, { type: 'string', name: 'name' }, { type: 'string', name: 'description' }, { type: 'bool', name: 'overwrite_on_duplicate_name' },
       { type: 'IEnumerable<long>', name: 'mediaids' }, { type: 'ResultCallback<Playlist>', name: 'cb_result' }],
      buildArgs([Arg.ref(profileObject(c).oid), Arg.str(name), Arg.str(''), Arg.bool(false), Arg.collection(keys.map((k) => buildArgs([Arg.long(BigInt(k))])))]), service.oid);
    if (!res.success) throw new RoonError(`Roon refused the playlist (${res.status})`);
    const end = Date.now() + 3000; let made: Any;
    while (Date.now() < end && !(made = allPlaylists(c).list.find((p) => field(p, 'Name') === name))) await wait(100);
    if (!made) throw new RoonError('Roon said ok, but the playlist isn\'t there — it may not have been made');
    return { ok: true, name, key: playlistKey(made), tracks: field(made, 'TrackCount') ?? keys.length };
  });
}

// ---- favourites, Listen Later, the library ----
/** A query on the library's albums (as in focus.ts), for the albums with a heart. */
export async function favorites(source: 'roon' | 'qobuz' | 'tidal', limit: number) {
  const n = Math.min(Math.max(1, limit), 100);
  if (source === 'roon') {
    const { library } = await import('./focus');
    const r = await library({ favorites: true }, 'added', false, n, 0);
    return { source, total: r.total, rows: r.rows };
  }
  return withCore(async (c) => {
    const { service, o } = streaming(c, source);
    const list = await shelf(c, service, o, 'GetFavoriteAlbums', 'AlbumLite', 0, n);
    return { source, total: list.total, rows: list.items.map((x) => albumRow(c, x)) };
  });
}

/** Re-reads one album or track from the Core (a fresh object), for the read-back after a change. */
async function reread(c: C, kind: 'album' | 'track', key: string): Promise<Any> {
  const method = kind === 'album' ? 'GetAlbumLite' : 'GetTrackLites';
  const res = kind === 'album'
    ? await short(c.call('Library', method, [{ type: 'long', name: 'albumid' }, { type: 'ResultCallback<AlbumLite>', name: 'cb_result' }], buildArgs([Arg.long(BigInt(key))]), c.serviceOid('Library')))
    : await short(c.call('Library', method, [{ type: 'IEnumerable<long>', name: 'trackids' }, { type: 'ResultCallback<IList<TrackLite>>', name: 'cb_result' }], buildArgs([Arg.collection([buildArgs([Arg.long(BigInt(key))])])]), c.serviceOid('Library')));
  if (!res?.success) return null;
  await wait(400);
  const all = [...c.graph.objects.values()].filter((o) => (kind === 'album' ? /\.Album(Lite)?$/ : /\.Track(Lite)?$/).test(o.typeName) && String(field(o, kind === 'album' ? 'AlbumId' : 'TrackId') ?? '') === key);
  return all[all.length - 1] ?? null;
}

/** A heart on an album or track (Library::FavoriteOrBan with a list of one link {id, Broker, Source}), then read back. */
export async function favorite(kind: 'album' | 'track', key: string, on: boolean) {
  return withCore(async (c) => {
    const o = kind === 'album' ? await findAlbum(c, key) : (await findTracks(c, [key]))[0];
    const members = [
      { name: kind === 'album' ? 'AlbumId' : 'TrackId', propType: 1, value: new BinaryWriter().long(BigInt(field(o, kind === 'album' ? 'AlbumId' : 'TrackId'))).toBuffer() },
      { name: 'Broker', propType: 23, value: new BinaryWriter().long(c.serviceOid('Broker')).toBuffer() }];
    const source = field(o, 'Source'); if (typeof source === 'number') members.push({ name: 'Source', propType: 9, value: new BinaryWriter().flexInt(source).toBuffer() });
    const link = c.structArg(`Sooloos.Broker.Api.${kind === 'album' ? 'AlbumLink' : 'TrackLink'}`, members);
    const res = await c.call('Library', 'FavoriteOrBan',
      [{ type: 'Sooid', name: 'profileid' }, { type: kind === 'album' ? 'IEnumerable<AlbumBase>' : 'IEnumerable<TrackBase>', name: 'items' }, { type: 'FavoriteBanState', name: 'state' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.sooid(c.profile()), Arg.collection([link]), Arg.enum_(on ? 1 : 0)]), c.serviceOid('Library'));
    if (!res.success) throw new RoonError(`Roon refused the heart (${res.status})`);
    const after = await reread(c, kind, String(field(o, kind === 'album' ? 'AlbumId' : 'TrackId')));
    const now = after ? flag(field(after, 'IsFavorite')) : undefined;
    return { ok: now === undefined || now === on, kind, title: field(o, 'Title'), favorite: now ?? on,
             note: now === undefined ? 'Roon said ok; the heart couldn\'t be read back' : now !== on ? 'Roon said ok, but the heart didn\'t change' : undefined };
  });
}

/** Listen Later (Library::GetListenLater; ListenLaterState: None 0, Pending 1, Played 2). */
export async function listenLater(includePlayed: boolean) {
  return withCore(async (c) => {
    const res = await c.call('Library', 'GetListenLater',
      [{ type: 'Profile', name: 'profile' }, { type: 'IList<string>', name: 'languageSettings' }, { type: 'ResultCallback<DataList<ListenLaterItem>>', name: 'cb_result' }],
      buildArgs([Arg.ref(profileObject(c).oid), Arg.collection([buildArgs([Arg.str('en')])])]), c.serviceOid('Library'));
    if (!res.success) throw new RoonError(`Roon refused Listen Later (${res.status})`);
    const list = items(c, decoded(c, res.payload));
    const thing = (it: Any) => field(it, 'Album') ?? field(it, 'Track') ?? field(it, 'Performer');
    await untilLoaded(c, list.map(thing).filter(isRef), 2500);
    const rows = list.map((it) => {
      const o = obj(c, thing(it));
      const r: Any = { ...(o ? resultRow(c, o) : { kind: field(it, 'DataType') ?? '?' }), state: ({ 1: 'waiting', 2: 'played' } as Any)[field(it, 'State')] ?? 'none' };
      const at = dotnetDate(field(it, 'Timestamp')); if (at) r.added = at;
      return r;
    }).filter((r) => includePlayed || r.state === 'waiting').sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? '')))
      .map((r) => ({ ...r, added: localTime(r.added) }));
    return { waiting: list.filter((it) => field(it, 'State') === 1).length, rows };
  });
}
export async function listenLaterSet(kind: 'album' | 'track', key: string, on: boolean) {
  return withCore(async (c) => {
    const o = kind === 'album' ? await findAlbum(c, key) : (await findTracks(c, [key]))[0];
    const res = await c.call('Library', 'SetListenLaterState',
      [{ type: 'Sooid', name: 'profileid' }, { type: kind === 'album' ? 'AlbumBase' : 'TrackBase', name: kind }, { type: 'ListenLaterState', name: 'state' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.sooid(c.profile()), Arg.ref(o.oid), Arg.enum_(on ? 1 : 0)]), c.serviceOid('Library'));
    if (!res.success) throw new RoonError(`Roon refused Listen Later (${res.status})`);
    const after = await reread(c, kind, String(field(o, kind === 'album' ? 'AlbumId' : 'TrackId')));
    const now = after ? flag(field(after, 'IsListenLater')) : undefined;
    return { ok: now === undefined || now === on, kind, title: field(o, 'Title'), listen_later: now ?? on,
             note: now === undefined ? 'Roon said ok; it couldn\'t be read back' : now !== on ? 'Roon said ok, but nothing changed' : undefined };
  });
}
/** A (Qobuz or TIDAL) album into the library (Library::AddToLibrary — no answer), then read back whether it's in. */
export async function libraryAdd(key: string) {
  return withCore(async (c) => {
    const album = await findAlbum(c, key);
    c.remoting.callMethodNoReply(c.serviceOid('Library'), formatMethodSignature('Library', 'AddToLibrary', [{ type: 'AlbumBase', name: 'album' }]), buildArgs([Arg.ref(album.oid)]));
    // The library copy is a new album with its own key, a few seconds later (12 Oct: in after ~10 s, key 4280264 → 223535).
    // Look for it by title and artist for up to 15 s.
    const title = String(field(album, 'Title') ?? ''), artist = clean(field(album, 'PerformedBy')).toLowerCase();
    let copy: Any = null;
    const end = Date.now() + 15000;
    while (!copy && Date.now() < end) {
      await wait(1500);
      const hits = await c.search(title, 20, false).catch(() => []);
      copy = hits.find((o) => /\.Album(Lite)?$/.test(o.typeName) && field(o, 'Source') === 1 && field(o, 'Title') === title
        && (clean(field(o, 'PerformedBy')).toLowerCase().includes(artist.split(/\s+(with|&|and)\s+/)[0]) || artist.includes(clean(field(o, 'PerformedBy')).toLowerCase())));
    }
    return { ok: true, title, artist: clean(field(album, 'PerformedBy')), in_library: !!copy, library_key: copy ? String(field(copy, 'AlbumId')) : undefined,
             note: copy ? undefined : 'Sent to Roon; it isn\'t in the library yet — Roon may still be importing it. Check with roon_search in a minute.' };
  });
}

// ---- other versions and more like this ----
export async function versions(key: string) {
  return withCore(async (c) => {
    const al = await findAlbum(c, key);
    const full = await fullAlbum(c, al);
    if (!isRef(full)) throw new RoonError('Roon doesn\'t give the full album');
    await untilField(c, full.$ref, 'AlternateVersionsReady', 4500);
    const av = obj(c, field(c.graph.getObject(full.$ref), 'AlternateAlbumVersions'));
    const group = (ns: string[]) => ns.flatMap((n) => items(c, field(av, n)));
    const all: [Any, boolean][] = [...group(['LibraryGroupVersions', 'LibraryOtherVersions']).map((x): [Any, boolean] => [x, true]), ...group(['StreamingVersions']).map((x): [Any, boolean] => [x, false])];
    await untilLoaded(c, all.map(([x]) => field(x, 'Album')).filter(isRef), 2500);
    const rate = (r: Any) => { const m = /(\d+(?:\.\d+)?)\s*kHz|FLAC (\d+)\/(\d+)/.exec(r.format ?? ''); return m ? Number(m[1] ?? m[2]) : 0; };
    const bits = (r: Any) => { const m = /(\d+)\s*bit|\/(\d+)$/.exec(r.format ?? ''); return m ? Number(m[1] ?? m[2]) : 0; };
    const rows = all.map(([x, lib]) => { const a = obj(c, field(x, 'Album')); if (!a || field(a, 'Title') === undefined) return null; const r: Any = albumRow(c, a); r.tracks = field(x, 'TrackCount') ?? undefined; r.lib = lib; return r; })
      .filter((r): r is Any => !!r && r.key !== String(field(al, 'AlbumId')));
    const order = (a: Any, b: Any) => rate(b) - rate(a) || bits(b) - bits(a) || (b.popularity ?? 0) - (a.popularity ?? 0);
    const strip = ({ lib, ...r }: Any) => r;   // eslint-disable-line @typescript-eslint/no-unused-vars
    return { album: albumRow(c, al), in_library: rows.filter((r) => r.lib).sort(order).map(strip), streaming: rows.filter((r) => !r.lib).sort(order).map(strip) };
  });
}
export async function similarAlbum(key: string, limit: number) {
  return withCore(async (c) => {
    const al = await findAlbum(c, key);
    const full = await fullAlbum(c, al);
    await wait(400);
    const A = isRef(full) ? c.graph.getObject(full.$ref) : null;
    const self = String(field(al, 'AlbumId'));
    const unique = (l: Any[]) => { const seen = new Set([self]); return l.filter((o) => o && field(o, 'Title') !== undefined && !seen.has(String(field(o, 'AlbumId'))) && seen.add(String(field(o, 'AlbumId')))).slice(0, limit).map((o) => albumRow(c, o)); };
    const res = await short(c.call('Library', 'GetOneBoxAlbumRecommendedForYou', [{ type: 'AlbumLite', name: 'album' }, { type: 'Sooid', name: 'profileid' }, { type: 'ResultCallback<DataList<AlbumLite>>', name: 'cb_result' }],
      buildArgs([Arg.ref(al.oid), Arg.sooid(c.profile())]), c.serviceOid('Library')), 8000);
    const recommended = res?.success ? items(c, decoded(c, res.payload)) : [];
    const similar = ['SimilarAlbums', 'SoundsSimilar', 'SeeAlso', 'WasInfluencedBy', 'WasInspiredBy'].flatMap((k) => items(c, field(A, k)));
    await untilLoaded(c, [...recommended, ...similar].map((o) => ({ $ref: o.oid })), 2500);
    return { album: albumRow(c, al), similar: unique(similar), recommended: unique(recommended) };
  });
}
export async function similarArtist(key: string, limit: number) {
  return withCore(async (c) => {
    const lv = await performer(c, key);
    if ((await untilField(c, lv.$ref, 'Name', 2000)) === undefined) throw new RoonError(`Roon knows no artist with key ${key}`, 'not_found');
    const res = await short(c.call('Library', 'GetOneBoxPerformerRecommendedAlbums', [{ type: 'PerformerLite', name: 'performer' }, { type: 'Sooid', name: 'profileid' }, { type: 'ResultCallback<PerformerRecommendedAlbums>', name: 'cb_result' }],
      buildArgs([Arg.ref(lv.$ref), Arg.sooid(c.profile())]), c.serviceOid('Library')), 8000);
    const w = res?.success ? obj(c, decoded(c, res.payload)) : null;
    const list = (k: string) => items(c, field(w, k));
    await untilLoaded(c, ['RecommendedAlbums', 'LatestAlbums', 'AppearsOnAlbums'].flatMap(list).map((o) => ({ $ref: o.oid })), 2500);
    const rows = (k: string) => list(k).filter((o) => field(o, 'Title') !== undefined).slice(0, limit).map((o) => albumRow(c, o));
    return { artist: { key, name: field(c.graph.getObject(lv.$ref), 'Name') }, recommended: rows('RecommendedAlbums'), latest: rows('LatestAlbums'), appears_on: rows('AppearsOnAlbums') };
  });
}

// ---- Roon's signal path: Zone.SignalPath → Quality, Elements, ProcessingSpeed, IsClipping ----
const QUALITY: Record<number, string> = { 0: 'inactive', 1: 'low', 2: 'high', 3: 'lossless', 4: 'enhanced', 5: 'none' };
const OUTPUT = ['Meridian', 'AirPlay', 'Songcast', 'RoonSpeakers', 'CoreAudio (shared)', 'CoreAudio (exclusive)', 'WASAPI (shared)', 'WASAPI (exclusive)', 'Android (shared)',
  'Android (exclusive)', 'Lossless', 'ASIO', 'Sonavox', 'RAAT', 'Squeezebox', 'ALSA', 'Digital', 'Analog', 'Analog/Digital', 'USB', 'Other', 'HQPlayer', 'AES', 'I2S', 'Sonos',
  'Ravenna', 'Speakers', 'Headphones', 'BluOS', 'Devialet', 'KEF', 'CoreAudio (iOS)', 'Songcast Direct', 'Chromecast', 'Android AA (exclusive)', 'Android AA (shared)', 'Bluetooth', 'MSB ProISL'];
const SRC: Record<number, string> = { 0: 'best effort', 1: 'high quality', 2: 'other', 3: 'MQA' };
const MEDIA: Record<number, string> = { 1: 'library', 128: 'Tidal', 256: 'Qobuz', 512: 'streaming' };
/** One step: the one filled member beside Quality/UniqueId names its kind (Source, Raat, SampleRateConversion, DSP,
 *  Output …); its simple fields are the details; a reference (the RAAT device) becomes its name. */
function step(c: C, e: Any): Any {
  const s: Any = { step: '?', quality: QUALITY[field(e, 'Quality') ?? 0] ?? String(field(e, 'Quality')) };
  for (const [k, v] of Object.entries(e?.fields || e || {})) {
    const name = k.split('::').pop()!;
    if (name === 'Quality' || name === 'UniqueId' || name.startsWith('$')) continue;
    const w = obj(c, v);
    if (!w || typeof w !== 'object' || Buffer.isBuffer(w)) continue;
    s.step = name;
    for (const [a, b] of Object.entries((w as Any).fields || w)) {
      const an = a.split('::').pop()!; if (an.startsWith('$')) continue;
      let value: Any = b;
      if (isRef(b)) value = field(obj(c, b), 'Name') ?? undefined;
      else if (typeof b === 'bigint') value = Number(b);
      else if (b === null || typeof b === 'object') continue;
      if (an === 'OutputType' && typeof b === 'number') value = OUTPUT[b] ?? b;
      if (an === 'Algorithm' && name === 'SampleRateConversion') value = SRC[b as number] ?? b;
      if (an === 'ContentSource') value = MEDIA[b as number] ?? b;
      if (value !== undefined) s[an] = value;
    }
  }
  return s;
}
const STATE: Record<number, string> = { 0: 'playing', 1: 'loading', 2: 'paused', 3: 'stopped' };
export async function signalPath(zoneName?: string) {
  return withCore(async (c) => {
    const names = zoneNames(c);
    let pick = zoneName ? String(findZone(c, zoneName).oid) : null;
    // Old zones with the same name (a Squeezebox player that reconnected leaves them): take the one that has a path.
    if (pick) {
      const hasPath = (oid: string) => items(c, field(obj(c, field(c.graph.getObject(BigInt(oid)), 'SignalPath')), 'Elements')).length > 0;
      if (!hasPath(pick)) {
        const target = names.get(pick);
        const same = new Set<string>();
        for (const e of c.graph.findByType('Endpoint')) { const z = field(e, 'Zone'); if (isRef(z) && field(e, 'Name') === target) same.add(String(z.$ref)); }
        const better = [...same].find(hasPath);
        if (better) { names.set(better, target!); pick = better; }
      }
    }
    return { zones: c.graph.findByType('Zone').filter((z) => names.has(String(z.oid)) && (!pick || String(z.oid) === pick)).map((z) => {
      const name = names.get(String(z.oid))!;
      const sp = obj(c, field(z, 'SignalPath'));
      const r: Any = { zone: name, state: officialZone(name)?.state ?? STATE[field(z, 'State') ?? 0], quality: QUALITY[field(sp, 'Quality') ?? 0] ?? String(field(sp, 'Quality')) };
      const els = items(c, field(sp, 'Elements'));
      if (!els.length) return r;      // a zone that doesn't play has no path
      const speed = field(sp, 'ProcessingSpeed'); if (typeof speed === 'number' && speed > 0) r.processing_speed = `${Math.round(speed * 10) / 10}x`;
      r.clipping = field(sp, 'IsClipping') === true;
      r.steps = els.map((e) => step(c, e));
      return r;
    }) };
  });
}

// ---- MUSE: an output's DSP (AudioDeviceCommonConfig::GetDspConfig → DspConfig) ----
const DSP_KIND: Record<string, string> = { HeadroomAdjustment: 'headroom', SampleRateConversion: 'sample_rate_conversion', BS2B: 'crossfeed', ParametricEqualizer: 'parametric_eq', PEQ: 'eq',
  Convolution: 'convolution', SpeakerSetup: 'speaker_setup', AudezePresets: 'audeze_presets', AudezeSpatializer: 'audeze_spatializer', SonarworksSR: 'sonarworks',
  OpenHeadphoneDatabase: 'headphone_eq', Radiance: 'radiance' };
async function dspOf(c: C, endpoint: Any): Promise<Any> {
  const cc = obj(c, field(obj(c, field(endpoint, 'Device')), 'CommonConfig'));
  if (!cc || field(cc, 'SupportsDspConfig') !== true) return null;
  const res = await short(c.call('AudioDeviceCommonConfig', 'GetDspConfig', [{ type: 'ResultCallback<DspConfig>', name: 'conf' }], Buffer.alloc(0), cc.oid), 6000);
  const v = res?.success ? decoded(c, res.payload) : null;
  if (!isRef(v)) return null;
  const end = Date.now() + 2500;
  while (Date.now() < end && field(c.graph.getObject(v.$ref), 'BeforeItems') === undefined && field(c.graph.getObject(v.$ref), 'Items') === undefined) await wait(50);
  await wait(150);
  return c.graph.getObject(v.$ref);
}
/** The parts of a DspConfig in order: each has one filled member that names its kind; the details are its simple
 *  values; what only says what's possible (Supports…, Min…, Max…, …Step) stays out. */
function dspParts(c: C, d: Any): Any[] {
  const out: Any[] = [];
  for (const list of ['BeforeItems', 'Items', 'AfterItems']) for (const it of items(c, field(d, list))) {
    const r: Any = { oid: it.oid, part: '?', on: field(it, 'IsEnabled') === true };
    for (const [k, v] of Object.entries(it.fields || {})) {
      const name = k.split('::').pop()!;
      if (['SupportsRemove', 'SupportsSetEnabled', 'IsEnabled'].includes(name) || name.startsWith('$')) continue;
      const w = obj(c, v);
      if (!w || typeof w !== 'object' || Buffer.isBuffer(w)) continue;
      r.part = DSP_KIND[name] ?? name;
      for (const [a, b] of Object.entries((w as Any).fields || w)) {
        const an = a.split('::').pop()!;
        if (an === 'SupportedSRCFilterType') { const l = obj(c, b); r.filter_choices = l?.$items ?? l?.fields?.$items ?? l; continue; }
        if (an.startsWith('$') || /^(Supports|Supported|Min|Max)/.test(an) || /Step$/.test(an) || an === 'BaseUrl' || an === 'LoadStatus') continue;
        if (typeof b === 'string' || typeof b === 'number' || typeof b === 'boolean') r[an] = b;
      }
    }
    out.push(r);
  }
  return out;
}
export async function dsp(zoneName?: string) {
  return withCore(async (c) => {
    const pick = zoneName ? findZone(c, zoneName).oid : null;
    const names = zoneNames(c); const zones: Any[] = [];
    for (const e of currentEndpoints(c)) {
      const z = field(e, 'Zone'); if (!isRef(z) || typeof field(e, 'Name') !== 'string' || (pick !== null && String(z.$ref) !== String(pick))) continue;
      const d = await dspOf(c, e);
      const r: Any = { zone: names.get(String(z.$ref)) ?? field(e, 'Name') };
      if (field(e, 'Name') !== r.zone) r.output = field(e, 'Name');
      if (!d) { r.dsp = 'not available'; zones.push(r); continue; }
      r.dsp_on = field(d, 'IsEnabled') === true;
      const active = field(obj(c, field(d, 'ActivePreset')), 'Name'); if (active) { r.preset = active; if (field(d, 'ActivePresetIsModified') === true) r.preset_modified = true; }
      r.presets = items(c, field(obj(c, field(d, 'DspPresets')), 'Presets')).map((p) => field(p, 'Name')).filter(Boolean);
      r.parts = dspParts(c, d).map(({ oid, ...rest }) => rest);   // eslint-disable-line @typescript-eslint/no-unused-vars
      zones.push(r);
    }
    return { zones };
  });
}
/** Switching: the whole DSP, one part, or loading a preset — then read back. */
export async function dspSet(zoneName: string, s: { enabled?: boolean; part?: string; preset?: string }) {
  return withCore(async (c) => {
    const z = findZone(c, zoneName);
    const e = outputsOf(c, z.oid)[0];
    const d = e ? await dspOf(c, e) : null;
    if (!d) throw new RoonError(`${z.name} has no DSP settings`, 'invalid');
    let res, what: Any;
    if (s.preset) {
      const p = items(c, field(obj(c, field(d, 'DspPresets')), 'Presets')).find((x) => String(field(x, 'Name') ?? '').toLowerCase() === s.preset!.toLowerCase());
      if (!p?.oid) throw new RoonError(`No preset "${s.preset}" on ${z.name}`, 'not_found');
      res = await c.call('DspConfig', 'LoadPreset', [{ type: 'DspPreset', name: 'preset' }, { type: 'ResultCallback', name: 'cb_result' }], buildArgs([Arg.ref(p.oid)]), d.oid);
      what = { preset: field(p, 'Name') };
    } else if (s.part) {
      if (s.enabled === undefined) throw new RoonError('Give `enabled` with the part', 'invalid');
      const it = dspParts(c, d).find((x) => x.part === s.part);
      if (!it) throw new RoonError(`No part "${s.part}" on ${z.name}; there is: ${dspParts(c, d).map((x) => x.part).join(', ')}`, 'not_found');
      res = await c.call('DspConfigItem', 'SetEnabled', [{ type: 'bool', name: 'enabled' }, { type: 'ResultCallback', name: 'cb_result' }], buildArgs([Arg.bool(s.enabled)]), it.oid);
      what = { part: it.part, enabled: s.enabled };
    } else {
      if (s.enabled === undefined) throw new RoonError('Say what to switch: `enabled` (with or without `part`), or a `preset`', 'invalid');
      res = await c.call('DspConfig', 'SetEnabled', [{ type: 'bool', name: 'enabled' }, { type: 'ResultCallback', name: 'cb_result' }], buildArgs([Arg.bool(s.enabled)]), d.oid);
      what = { enabled: s.enabled };
    }
    log(`dsp: ${z.name} ← ${JSON.stringify(what)} → ${res.success ? 'ok' : res.status}`);
    if (!res.success) throw new RoonError(`Roon refused the DSP change (${res.status})`);
    if (field(d, 'AutoApply') !== true) { try { c.remoting.callMethodNoReply(d.oid, formatMethodSignature('DspConfig', 'Apply', []), Buffer.alloc(0)); } catch { /* applied by itself */ } }
    // Read back — Roon pushes the change a moment later (12 Oct: read at 0.5 s it still showed the old state), so look for
    // up to 3 s before saying it didn't change.
    let check: boolean | undefined;
    const end = Date.now() + 3000;
    do {
      await wait(400);
      const after = await dspOf(c, e);
      check = !after ? undefined : s.preset ? field(obj(c, field(after, 'ActivePreset')), 'Name') === what.preset
        : s.part ? dspParts(c, after).find((x) => x.part === s.part)?.on === s.enabled : (field(after, 'IsEnabled') === true) === s.enabled;
    } while (check === false && Date.now() < end);
    // Within the same connection the Core doesn't always push the part's new state (12 Oct: switched off, still "on" here,
    // "off" over a new connection). One more look over a fresh one before saying it didn't change.
    if (check === false) {
      const c2 = await fresh();
      const z2 = findZone(c2, zoneName);
      const e2 = outputsOf(c2, z2.oid)[0];
      const after = e2 ? await dspOf(c2, e2) : null;
      check = !after ? undefined : s.preset ? field(obj(c2, field(after, 'ActivePreset')), 'Name') === what.preset
        : s.part ? dspParts(c2, after).find((x) => x.part === s.part)?.on === s.enabled : (field(after, 'IsEnabled') === true) === s.enabled;
    }
    return { ok: check !== false, zone: z.name, ...what, note: check === false ? 'Roon said ok, but the DSP didn\'t change' : undefined };
  });
}
