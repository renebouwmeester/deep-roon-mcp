// Search, the streaming shelves and genres (Qobuz, TIDAL), an album's page, reviews, biographies and discographies — read-only.
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { BinaryReader } from '../intern/proto/reader';
import { BinaryWriter } from '../intern/proto/writer';
import { withCore, RoonError } from '../core/session';
import { Any, C, albumRow, clean, dateText, duration, field, flag, imageKey, items, obj, partialList, refList, resultRow, short, strings, untilField, untilLoaded, wait, trackArtist } from './graph';

// ---- the streaming services ----
export type Service = 'qobuz' | 'tidal';
export const SERVICE_NAME: Record<Service, string> = { qobuz: 'Qobuz', tidal: 'TIDAL' };
const SERVICE_TYPE: Record<Service, string> = { qobuz: 'Qobuz', tidal: 'Tidal' };
/** The service object when it's signed in on this Core (LoginStatus 4 — both services, measured 12 Oct 2026), else null. */
export function signedIn(c: C, s: Service): Any | null {
  const o = c.graph.findByType(SERVICE_TYPE[s])[0];
  if (!o) return null;
  const st = field(o, 'LoginStatus');
  return st === undefined || st === 4 ? o : null;
}
/** The service to ask: the one asked for, else Qobuz when it's signed in, else TIDAL. */
export function streaming(c: C, wanted?: Service): { service: Service; o: Any } {
  if (wanted) {
    const o = signedIn(c, wanted);
    if (!o) throw new RoonError(`${SERVICE_NAME[wanted]} isn't signed in on this Roon Core`, 'unavailable');
    return { service: wanted, o };
  }
  for (const s of ['qobuz', 'tidal'] as Service[]) { const o = signedIn(c, s); if (o) return { service: s, o }; }
  throw new RoonError('Neither Qobuz nor TIDAL is signed in on this Roon Core', 'unavailable');
}
/** A PartialList answer from a service, its objects loaded. */
type Params = { types: { type: string; name: string }[]; args: Buffer };
const NONE: Params = { types: [], args: Buffer.alloc(0) };
export async function shelf(c: C, s: Service, o: Any, method: string, of: string, offset: number, count: number, before: Params = NONE, after: Params = NONE) {
  const res = await c.call(SERVICE_TYPE[s], method, [...before.types, { type: 'int', name: 'offset' }, { type: 'int', name: 'count' }, ...after.types, { type: `ResultCallback<PartialList<${of}>>`, name: 'cb_result' }],
    Buffer.concat([before.args, buildArgs([Arg.int(Math.max(0, offset)), Arg.int(Math.min(Math.max(1, count), 100))]), after.args]), o.oid);
  if (!res.success) throw new RoonError(`${SERVICE_NAME[s]}::${method}: ${res.status}`);
  const list = partialList(c, c.graph.decodeReturnValue(Uint8Array.from(res.payload)));
  await untilLoaded(c, list.items);
  return { total: list.total, items: list.items.map((x) => obj(c, x)).filter(Boolean) };
}

export async function search(query: string, limit: number, kind?: 'album' | 'track' | 'artist') {
  return withCore(async (c) => {
    const n = Math.min(Math.max(1, limit), 100);
    // The results come as top hits, artists, composers, albums, tracks: a long artist list fills the limit before the
    // tracks' turn ("long long long beatles" → a hundred artists). With a kind, ask wide and filter here.
    const res = await c.search(query, kind ? 400 : n, false);
    let rows = res.map((o) => resultRow(c, o));
    if (kind) rows = rows.filter((r: Any) => r.kind === kind).slice(0, n);
    return { query, rows };
  });
}

export const SECTIONS: Record<Service, Record<string, string>> = {
  qobuz: { new: 'GetNewAlbums', qobuzissimes: 'GetQobuzissimesAlbums', press_awards: 'GetPressAwardsAlbums', top: 'GetTopAlbums',
           trending: 'GetStillTrendingAlbums', ideal_discography: 'GetIdealDiscographyAlbums' },
  tidal: { new: 'GetNew', recommended: 'GetRecommended', top: 'GetTop', rising: 'GetRising', masters: 'GetMasters' },
};

/** A shelf of albums (or, at TIDAL, of tracks). Qobuz narrows by genre ids; TIDAL by one genre (its name or path) and has
 *  no genre filter on its other shelves — a genre there means TIDAL's genre page (Tidal::GetGenreAlbums / GetGenreTracks). */
export async function section(name: string, limit: number, offset: number, genres: string[] = [], wanted?: Service, what: 'albums' | 'tracks' = 'albums') {
  return withCore(async (c) => {
    const { service, o } = streaming(c, wanted);
    const methods = SECTIONS[service];
    if (!methods[name] && !(service === 'tidal' && genres.length)) throw new RoonError(`${SERVICE_NAME[service]} has no shelf "${name}"; choose from ${Object.keys(methods).join(', ')}`, 'invalid');
    if (what === 'tracks' && service !== 'tidal') throw new RoonError('Shelves of tracks are TIDAL\'s; Qobuz\'s shelves are albums', 'invalid');
    if (what === 'tracks' && name === 'masters') throw new RoonError('TIDAL\'s masters shelf is albums only', 'invalid');
    let res;
    if (service === 'qobuz') {
      if (genres.some((g) => !/^\d+$/.test(g))) throw new RoonError('Qobuz genres are ids (numbers) — see roon_genres', 'invalid');
      res = await shelf(c, service, o, methods[name], 'AlbumLite', offset, limit, NONE,
        { types: [{ type: 'IList<string>', name: 'filter_genre_ids' }], args: buildArgs([Arg.collection(genres.map((g) => buildArgs([Arg.str(g)])))]) });
    } else if (genres.length) {
      const g = await tidalPick(c, o, 'GetGenres', genres[0]);
      res = await shelf(c, service, o, what === 'tracks' ? 'GetGenreTracks' : 'GetGenreAlbums', what === 'tracks' ? 'TrackLite' : 'AlbumLite', offset, limit,
        { types: [{ type: 'TidalGenre', name: 'genre' }], args: tidalStruct(c, 'TidalGenre', g) });
    } else {
      res = await shelf(c, service, o, methods[name] + (what === 'tracks' ? 'Tracks' : 'Albums'), what === 'tracks' ? 'TrackLite' : 'AlbumLite', offset, limit);
    }
    return { service: SERVICE_NAME[service], section: genres.length && service === 'tidal' ? undefined : name, genre: genres.length ? genres : undefined,
             what: service === 'tidal' ? what : undefined, total: res.total, offset, rows: res.items.map((x) => resultRow(c, x)) };
  });
}

/** TIDAL's genres and moods (Tidal::GetGenres / GetMoods): structs {Name, Path, Image} by value — the length, the count,
 *  and per item a marker, a type number, a length and the members as (index, value): 1 = Name, 2 = Path, 3 = Image. */
async function tidalList(c: C, o: Any, method: 'GetGenres' | 'GetMoods'): Promise<{ name: string; path: string }[]> {
  const res = await c.call('Tidal', method, [{ type: `ResultCallback<IList<${method === 'GetGenres' ? 'TidalGenre' : 'TidalMood'}>>`, name: 'cb_result' }], Buffer.alloc(0), o.oid);
  if (!res.success) throw new RoonError(`TIDAL::${method}: ${res.status}`);
  const rows: { name: string; path: string }[] = [];
  if (res.payload.length > 2) {
    const r = new BinaryReader(Uint8Array.from(res.payload)); r.integer(); const n = r.flexInt();
    for (let i = 0; i < n && r.remaining > 0; i++) {
      r.flexInt(); r.flexInt(); const len = r.flexInt(); const m = new BinaryReader(r.bytes(len)); const g: Any = {};
      while (m.remaining > 0) { const idx = m.flexInt(); if (idx !== 1 && idx !== 2) break; const t = m.string(); if (idx === 1) g.name = t; else g.path = t; }
      if (g.path) rows.push({ name: g.name ?? g.path, path: g.path });
    }
  }
  return rows;
}
/** One TIDAL genre or mood by its path or name (any case). */
export async function tidalPick(c: C, o: Any, method: 'GetGenres' | 'GetMoods', want: string) {
  const all = await tidalList(c, o, method);
  const w = want.trim().toLowerCase();
  const g = all.find((x) => x.path.toLowerCase() === w) ?? all.find((x) => x.name.toLowerCase() === w);
  if (!g) throw new RoonError(`TIDAL has no ${method === 'GetGenres' ? 'genre' : 'mood'} "${want}"; choose from ${all.map((x) => x.path).join(', ')}`, 'invalid');
  return g;
}
/** A TidalGenre or TidalMood by value, for the methods that take one. */
export function tidalStruct(c: C, type: 'TidalGenre' | 'TidalMood', g: { name: string; path: string }): Buffer {
  const T = `Sooloos.Broker.Api.${type}`;
  return c.structArg(T, [{ name: `string ${T}::Name`, propType: 20, value: new BinaryWriter().string(g.name).toBuffer() },
                         { name: `string ${T}::Path`, propType: 20, value: new BinaryWriter().string(g.path).toBuffer() }]);
}

/** The genres of a service: Qobuz's with their ids (Qobuz::GetGenres: a list of structs {Name, GenreId} by value — the
 *  length, the count, and per item a marker (1 = by value), a type number, a length and the members as (index, text) up
 *  to a 0); TIDAL's genres and moods with their paths. */
export async function genres(parent?: string, wanted?: Service) {
  return withCore(async (c) => {
    const { service, o } = streaming(c, wanted);
    if (service === 'tidal') {
      if (parent) throw new RoonError('TIDAL\'s genres have no sub-genres', 'invalid');
      const [g, m] = [await tidalList(c, o, 'GetGenres'), await tidalList(c, o, 'GetMoods')];
      return { service: 'TIDAL', genres: g.map((x) => ({ id: x.path, name: x.name })), moods: m.map((x) => ({ id: x.path, name: x.name })) };
    }
    const res = await c.call('Qobuz', 'GetGenres', [{ type: 'string', name: 'parentGenreId' }, { type: 'ResultCallback<IList<QobuzGenre>>', name: 'cb_result' }],
      buildArgs([Arg.str(parent || null)]), o.oid);
    if (!res.success) throw new RoonError(`Qobuz::GetGenres: ${res.status}`);
    const rows: { id: string; name?: string }[] = [];
    if (res.payload.length > 2) {
      const r = new BinaryReader(Uint8Array.from(res.payload)); r.integer(); const n = r.flexInt();
      for (let i = 0; i < n && r.remaining > 0; i++) {
        r.flexInt(); r.flexInt(); const len = r.flexInt(); const m = new BinaryReader(r.bytes(len)); const g: Any = {};
        for (;;) { const idx = m.remaining > 0 ? m.flexInt() : 0; if (!idx) break; const t = m.string(); if (idx === 1) g.name = t; else if (idx === 2) g.id = t; }
        if (g.id) rows.push({ id: g.id, name: g.name });
      }
    }
    return { service: 'Qobuz', parent: parent || undefined, genres: rows };
  });
}

const library = (c: C) => c.serviceOid('Library');

/** The album for a key: from the graph if it's there, else fetched from the Core again. A Qobuz album that's also in the
 *  library comes back as the library album (its key may differ). */
export async function findAlbum(c: C, key: string): Promise<Any> {
  const inGraph = [...c.graph.objects.values()].find((o) => /\.Album(Lite)?$/.test(o.typeName) && String(field(o, 'AlbumId') ?? '') === key && field(o, 'Title') !== undefined);
  if (inGraph) return inGraph;
  if (!/^\d+$/.test(key)) throw new RoonError('An album key is a number', 'invalid');
  const res = await short(c.call('Library', 'GetAlbumLite', [{ type: 'long', name: 'albumid' }, { type: 'ResultCallback<AlbumLite>', name: 'cb_result' }], buildArgs([Arg.long(BigInt(key))]), library(c)));
  const v = res?.success && res.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(res.payload)) : null;
  if (isRef(v)) { await untilLoaded(c, [v], 2000); const o = c.graph.getObject(v.$ref); if (o && field(o, 'Title') !== undefined) return o; }
  throw new RoonError(`Roon knows no album with key ${key}`, 'not_found');
}

/** The tracks for a list of keys, in that order; an unknown key gives an error naming it. */
export async function findTracks(c: C, keys: string[], lenient = false): Promise<Any[]> {
  const look = () => { const all = [...c.graph.objects.values()].filter((o) => /\.Track(Lite)?$/.test(o.typeName) && field(o, 'Title') !== undefined); return keys.map((k) => all.find((o) => String(field(o, 'TrackId') ?? '') === k)); };
  let tracks = look();
  const missing = keys.filter((_, i) => !tracks[i]);
  if (missing.length) {
    if (missing.some((k) => !/^\d+$/.test(k))) throw new RoonError('A track key is a number', 'invalid');
    const res = await short(c.call('Library', 'GetTrackLites', [{ type: 'IEnumerable<long>', name: 'trackids' }, { type: 'ResultCallback<IList<TrackLite>>', name: 'cb_result' }],
      buildArgs([Arg.collection(missing.map((k) => buildArgs([Arg.long(BigInt(k))])))]), library(c)));
    if (res?.success) await untilLoaded(c, refList(res.payload).map((oid) => ({ $ref: oid })), 2500);
    tracks = look();
  }
  const gone = keys.filter((_, i) => !tracks[i]);
  if (gone.length && lenient) return tracks;   // nulls where Roon no longer knows the key
  if (gone.length) throw new RoonError(`Roon doesn't know ${gone.length} of the ${keys.length} tracks (keys ${gone.join(', ')})`, 'not_found');
  return tracks;
}

/** The full album (Library::GetAlbum, also for a Qobuz album outside the library), or null. */
export async function fullAlbum(c: C, al: Any): Promise<Any> {
  const res = await short(c.call('Library', 'GetAlbum', [{ type: 'AlbumBase', name: 'album' }, { type: 'ResultCallback<Album>', name: 'cb_result' }], buildArgs([Arg.ref(al.oid)]), library(c)), 6000);
  return res?.success && res.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(res.payload)) : null;
}

const CREDIT_KIND: Record<number, string> = { 1: 'composition', 2: 'conductor', 3: 'main artist', 4: 'performance', 5: 'ensemble', 6: 'production' };

/** An album's page: the album, its facts, its main artists (with a key for the discography) and its tracks with keys. */
export async function album(key: string, withCredits: boolean, withFileTags = false) {
  return withCore(async (c) => {
    const al = await findAlbum(c, key);
    // The tracks come after the full album; if that fails, the light list.
    let refs: bigint[] = [];
    const full = await fullAlbum(c, al);
    if (isRef(full)) {
      const end = Date.now() + 3500;
      while (Date.now() < end) {
        const list = obj(c, field(c.graph.getObject(full.$ref), 'Tracks'))?.fields?.$items ?? [];
        if (list.length && list.every((x: Any) => field(obj(c, x), 'Title') !== undefined)) { refs = list.map((x: Any) => x.$ref); break; }
        await wait(50);
      }
    }
    if (!refs.length) {
      const res = await short(c.call('Library', 'GetAlbumTrackLites', [{ type: 'AlbumBase', name: 'album' }, { type: 'ResultCallback<IList<TrackLite>>', name: 'cb_result' }], buildArgs([Arg.ref(al.oid)]), library(c)));
      if (!res?.success) throw new RoonError(`The tracks of this album don't come (${res?.status ?? 'no answer'})`);
      refs = refList(res.payload);
      await untilLoaded(c, refs.map((oid) => ({ $ref: oid })), 2500);
    }
    const raw = refs.map((oid) => c.graph.getObject(oid)).filter((t) => t && field(t, 'Title') !== undefined);
    const discs = new Set(raw.map((t) => field(t, 'MediaNumber') ?? 1)).size > 1;
    const formats = new Set(raw.map((t) => field(t, 'Format'))).size > 1;
    let seconds = 0;
    const tracks = raw.map((t) => {
      const r: Any = { key: String(field(t, 'TrackId') ?? '') };
      if (discs) r.disc = field(t, 'MediaNumber') ?? 1;
      const n = field(t, 'TrackNumber'); if (n != null) r.n = n;
      r.title = field(t, 'Title');
      trackArtist(c, r, t, al);
      const l = field(t, 'LengthSeconds'); if (typeof l === 'number') { r.length = duration(l); seconds += l; }
      if (formats && field(t, 'Format')) r.format = field(t, 'Format');
      if (flag(field(t, 'IsFavorite'))) r.favorite = true;
      return r;
    });
    const out: Any = { album: albumRow(c, al) };
    const main = items(c, field(al, 'MainPerformers')).filter((p) => field(p, 'Name'));
    if (main.length) out.artists = main.map((p) => ({ key: String(field(p, 'PerformerId') ?? ''), name: field(p, 'Name') }));
    if (seconds) out.length = duration(seconds);
    // The disc count (19 Nov 2026, forum (J): "whether Roon treated a folder as one multi-disc album or as several") — always,
    // also 1; the disc per track only when there are more.
    out.discs = new Set(raw.map((t) => field(t, 'MediaNumber') ?? 1)).size;
    out.tracks = tracks;
    // The tags in the files (19 Nov 2026, forum (J): ROONALBUMTAG / ROONTRACKTAG per track): Library::GetTrackExportInfoForAlbums
    // → TrackExportInfo.FileTags, (name, value) per tag as the file has them. Local files only; streaming albums have none.
    if (withFileTags) {
      const res = await short(c.call('Library', 'GetTrackExportInfoForAlbums', [{ type: 'IEnumerable<AlbumBase>', name: 'albums' }, { type: 'ResultCallback<IList<TrackExportInfo>>', name: 'cb_result' }],
        buildArgs([Arg.collection([buildArgs([Arg.ref(al.oid)])])]), library(c)), 8000);
      // The answer is an IList of structs inline (measured 19 Nov 2026: not graph objects — the path is in the payload itself): the
      // length, the count, then each TrackExportInfo read as a value, like the Focus histograms.
      const infos: Any[] = [];
      if (res?.success && res.payload.length > 2) {
        const r = new BinaryReader(Uint8Array.from(res.payload)); r.integer(); const n = r.flexInt();
        const graph = c.graph as Any;
        for (let i = 0; i < n && r.remaining > 0; i++) infos.push(graph.readValue(r, 23));
      }
      await untilLoaded(c, infos.map((e) => field(e, 'Track')).filter(isRef), 2500);
      // FileTags comes as the bytes of an IList<Tuple<string,string>>: the count, then per tuple a byte array that holds the name and
      // the value as two strings (measured 19 Nov 2026: \x05TITLE\tHoneylake).
      const tagsOf = (raw: Any): Any => {
        const out: Any = {};
        if (!Buffer.isBuffer(raw) || !raw.length) return out;
        try {
          const r = new BinaryReader(Uint8Array.from(raw)); const n = r.flexInt();
          for (let i = 0; i < n && r.remaining > 0; i++) {
            const blob = r.byteArray(); if (!blob) continue;
            const t = new BinaryReader(Uint8Array.from(blob)); const k = t.string(), val = t.string();
            if (k) out[k] = out[k] !== undefined ? ([] as Any[]).concat(out[k], val) : val;
          }
        } catch { /* a form we don't know: no tags rather than wrong ones */ }
        return out;
      };
      const byRef = new Map<string, Any>();
      // By TrackId: the export's Track is another object than the album's track rows (measured: other refs, same id).
      for (const e of infos) { const id = field(obj(c, field(e, 'Track')), 'TrackId') ?? field(e, 'TrackId'); if (id != null) byRef.set(String(id), tagsOf(field(e, 'FileTags'))); }
      for (const r of tracks) { const tg = byRef.get(r.key); if (tg && Object.keys(tg).length) r.file_tags = tg; }
      if (!infos.length) out.file_tags = 'none: a streaming album, or Roon has no files for it';
    }
    // The facts of the album page: labels and genres by value in the album, the rest on the full album.
    const A = isRef(full) ? c.graph.getObject(full.$ref) : null;
    const g = strings(c, field(al, 'Genres')); if (g.length) out.genres = g;
    const released = dateText(field(al, 'OriginalReleaseDate')), edition = dateText(field(al, 'ReleaseDate'));
    if (released) out.released = released; if (edition && edition !== released) out.this_release = edition;
    const version = field(al, 'Version'); if (typeof version === 'string' && version) out.version = version;
    for (const [k, name] of [['CatalogNumber', 'catalogue_number'], ['ProductCode', 'barcode'], ['Country', 'country']]) { const w = field(A, k); if (typeof w === 'string' && w) out[name] = w; }
    for (const [k, name] of [['IsLive', 'live'], ['IsCompilation', 'compilation'], ['IsPick', 'roon_pick']]) if (field(al, k) === true) out[name] = true;
    // Identification (19 Nov 2026, forum (J): "the release Roon matched"): Roon's own id of the metadata album it matched (and
    // AllMusic's, when that's the source). A MusicBrainz id isn't in what the protocol returns.
    out.identified = field(al, 'IsIdentified') === true;
    if (A && field(A, 'IsIdentificationInProgress') === true) out.identifying = true;
    const ext = field(A, 'ExternalAlbumId');
    if (Buffer.isBuffer(ext)) {
      out.roon_album_id = ext.toString('hex');
      // A metadata id as text after a two-byte kind (measured 19 Nov 2026: 79 00 + "MW0003887740") — AllMusic's album id, the one in
      // its URLs (…-mw0003887740). Roon's own ids are binary (3e 01 …) and stay hex only.
      const rest = ext.subarray(2).toString('latin1');
      if (ext.length > 4 && /^MW\d{6,}$/.test(rest)) out.allmusic_id = rest.toLowerCase();
    }
    if (withCredits && A) {
      // Album.Credits: {Role, Performer, Type} — grouped by role, in Roon's order. Roon's own data, as Roon has it.
      const byRole = new Map<string, Any>();
      for (const cr of items(c, field(A, 'Credits'))) {
        const role = field(cr, 'Role'), name = field(obj(c, field(cr, 'Performer')), 'Name');
        if (!role || !name) continue;
        const e = byRole.get(role) ?? { role, category: CREDIT_KIND[field(cr, 'Type')] ?? undefined, names: [] };
        if (!e.names.includes(name)) e.names.push(name);
        byRole.set(role, e);
      }
      out.credits = [...byRole.values()];
    }
    return out;
  });
}

// ---- reviews and biographies ----
// The texts aren't in the album or artist themselves (Review and Biography stay empty): Roon fetches them with
// Library::GetLocalizedEntityText(Sooid? external id, long own id, kind, sources) → LocalizedDescriptionContainer.Blobs.
// The kinds ("review", "biography") and sources ("Rovi-albums:en", "Rovi-artists:en", "Wikipedia:en") are the ones Roon's
// own app asks for; without the external id the Core says InvalidArgument.
export interface Blob { source: string; author?: string; url?: string; text: string }
export async function entityText(c: C, external: Any, id: Any, kind: string, sources: string[]): Promise<Blob[]> {
  if (!Buffer.isBuffer(external)) return [];
  const args = Buffer.concat([new BinaryWriter().optionalSooid(external).toBuffer(), buildArgs([Arg.long(BigInt(id)), Arg.str(kind), Arg.collection(sources.map((s) => buildArgs([Arg.str(s)])))])]);
  const res = await short(c.call('Library', 'GetLocalizedEntityText',
    [{ type: 'Sooid?', name: 'sooid' }, { type: 'long', name: 'selfid' }, { type: 'string', name: 'blobtype' }, { type: 'IList<string>', name: 'sources' }, { type: 'ResultCallback<LocalizedDescriptionContainer>', name: 'cb' }],
    args, library(c)), 8000);
  if (!res?.success || !res.payload.length) return [];
  const container = obj(c, c.graph.decodeReturnValue(Uint8Array.from(res.payload)));
  return items(c, field(container, 'Blobs')).filter((b) => field(b, 'Text'))
    .map((b) => ({ source: /^rovi/i.test(String(field(b, 'Source'))) ? 'Roon (TiVo)' : String(field(b, 'Source') ?? ''), author: field(b, 'Author') ?? undefined, url: field(b, 'SourceUrl') ?? undefined, text: clean(field(b, 'Text')).trim() }));
}
const cut = (b: Blob, max: number) => {
  const r: Any = { source: b.source, author: b.author, url: b.url, length: b.text.length, text: b.text };
  if (b.text.length > max) { r.text = b.text.slice(0, max).replace(/\s+\S*$/, '') + ' …'; r.truncated = true; }
  return r;
};
/** Roon's own text (TiVo) first; Wikipedia when asked, or when there's nothing else. In full, unless a limit is asked. */
export const choose = (blobs: Blob[], max: number, wiki: boolean) => {
  const own = blobs.filter((b) => b.source !== 'Wikipedia'), w = blobs.filter((b) => b.source === 'Wikipedia');
  return [...own, ...(wiki || !own.length ? w : [])].map((b) => cut(b, max));
};

export async function review(key: string, max: number, wiki: boolean) {
  return withCore(async (c) => {
    const al = await findAlbum(c, key);
    const full = await fullAlbum(c, al);
    const external = isRef(full) ? await untilField(c, full.$ref, 'ExternalAlbumId') : undefined;
    const texts = choose(await entityText(c, external, field(al, 'AlbumId'), 'review', ['Rovi-albums:en', 'Wikipedia:en']), max, wiki);
    return { album: albumRow(c, al), texts, note: texts.length ? undefined : 'Roon has no review for this album.' };
  });
}

export async function performer(c: C, key: string): Promise<Any> {
  if (!/^\d+$/.test(key)) throw new RoonError('An artist key is a number', 'invalid');
  // The light artist by number first, then the full one by reference: GetPerformer(long) doesn't know an artist outside
  // the library (measured: The Kinks → refused at once).
  const light = await short(c.call('Library', 'GetPerformerLite', [{ type: 'long', name: 'performerid' }, { type: 'ResultCallback<PerformerLite>', name: 'cb_result' }], buildArgs([Arg.long(BigInt(key))]), library(c)));
  const lv = light?.success && light.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(light.payload)) : null;
  if (!isRef(lv)) throw new RoonError(`Roon knows no artist with key ${key}`, 'not_found');
  return lv;
}

export async function bio(key: string, max: number, wiki: boolean) {
  return withCore(async (c) => {
    const lv = await performer(c, key);
    const res = await short(c.call('Library', 'GetPerformer', [{ type: 'PerformerBase', name: 'performer' }, { type: 'ResultCallback<Performer>', name: 'cb_result' }], buildArgs([Arg.ref(lv.$ref)]), library(c)), 5000);
    const v = res?.success && res.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(res.payload)) : null;
    if (!isRef(v) || (await untilField(c, v.$ref, 'Name', 2000)) === undefined) throw new RoonError(`Roon knows no artist with key ${key}`, 'not_found');
    const external = await untilField(c, v.$ref, 'ExternalPerformerId');
    const texts = choose(await entityText(c, external, key, 'biography', ['Rovi-artists:en', 'Wikipedia:en']), max, wiki);
    const p = c.graph.getObject(v.$ref);
    const list = (name: string): Any[] => obj(c, field(p, name))?.fields?.$items ?? [];
    await untilLoaded(c, ['SimilarTo', 'Followed', 'Influenced', 'CollaboratorWith', 'IsAssociatedWith', 'MemberOf', 'Members'].flatMap((k) => list(k).slice(0, 12)).filter(isRef), 1500);
    const people = (...names: string[]) => {
      const out: { key?: string; name: string; image?: string }[] = [];
      for (const n of names) for (const x of list(n)) {
        const o = obj(c, x); const name = field(o, 'Name');
        if (name && !out.some((y) => y.name === name)) { const r: { key?: string; name: string; image?: string } = { key: String(field(o, 'PerformerId') ?? '') || undefined, name }; const img = imageKey(c, o, 'Photo') ?? imageKey(c, o, 'Avatar'); if (img) r.image = img; out.push(r); }
      }
      return out.length ? out.slice(0, 12) : undefined;
    };
    const artist: Any = { key, name: field(p, 'Name') };
    const country = field(p, 'Country'); if (country) artist.country = country;
    const from = field(p, 'BirthPlace'); if (from) artist.from = from;
    const ya = field(p, 'YearsActive'); if (Buffer.isBuffer(ya) && ya.length >= 2) { const y = new BinaryReader(Uint8Array.from(ya)).flexInt() >>> 16; if (y > 1000 && y < 3000) artist.active_since = y; }
    const g = list('Genres').filter((x) => typeof x === 'string'); if (g.length) artist.genres = g;
    const img = imageKey(c, p, 'Photo') ?? imageKey(c, p, 'Avatar'); if (img) artist.image = img;
    return { artist, texts, note: texts.length ? undefined : 'Roon has no biography for this artist.',
             similar: people('SimilarTo'), influenced_by: people('Followed'), influenced: people('Influenced'),
             worked_with: people('CollaboratorWith', 'IsAssociatedWith'), member_of: people('MemberOf'), members: people('Members') };
  });
}

/** The discography: an artist's main albums at Qobuz or TIDAL (<Service>::GetPerformerMainAlbumLites), oldest first. */
export async function discography(key: string, wanted?: Service) {
  return withCore(async (c) => {
    const { service, o: q } = streaming(c, wanted);
    const pv = await performer(c, key);
    const end = Date.now() + 1500; while (Date.now() < end && field(c.graph.getObject(pv.$ref), 'Name') === undefined) await wait(40);
    const p = c.graph.getObject(pv.$ref);
    if (!p || field(p, 'Name') === undefined) throw new RoonError(`Roon knows no artist with key ${key}`, 'not_found');
    const res = await c.call(SERVICE_TYPE[service], 'GetPerformerMainAlbumLites', [{ type: 'long', name: 'performerid' }, { type: 'ResultCallback<IList<AlbumLite>>', name: 'cb_result' }], buildArgs([Arg.long(BigInt(key))]), q.oid);
    if (!res.success) throw new RoonError(`${SERVICE_NAME[service]}::GetPerformerMainAlbumLites: ${res.status}`);
    const refs = refList(res.payload);
    await untilLoaded(c, refs.map((oid) => ({ $ref: oid })), 3000);
    const albums = refs.map((oid) => c.graph.getObject(oid)).filter((o) => o && field(o, 'Title') !== undefined).map((o) => albumRow(c, o))
      .map((r, i) => ({ r, i })).sort((a, b) => (a.r.year ?? 9999) - (b.r.year ?? 9999) || a.i - b.i).map((x) => x.r);
    const artist: Any = { key, name: field(p, 'Name') };
    const n = field(p, 'MainPerformerAlbumCount'); if (typeof n === 'number') artist.albums_in_library = n;
    const from = field(p, 'BirthPlace'); if (from) artist.from = from;
    const img = imageKey(c, p, 'Photo') ?? imageKey(c, p, 'Avatar'); if (img) artist.image = img;
    return { service: SERVICE_NAME[service], artist, albums };
  });
}

// ---- file paths (0.4.6) ----
// Roon's own export (Library::GetTrackExportInfo…, the data behind its Export): per track the file as the Core sees it,
// plus any duplicates. Asked for on the Roon forum: "a unique key to join on" with per-file waveform data. Local files
// only — a streaming track has no file and comes back without a path.
export async function trackFiles(a: { album?: string; artist?: string; tracks?: string[] }) {
  return withCore(async (c) => {
    const cb = { type: 'ResultCallback<IList<TrackExportInfo>>', name: 'cb_result' };
    let res;
    if (a.tracks?.length) {
      if (a.tracks.some((k) => !/^\d+$/.test(k))) throw new RoonError('A track key is a number', 'invalid');
      res = await short(c.call('Library', 'GetTrackExportInfo', [{ type: 'IEnumerable<long>', name: 'ids' }, cb],
        buildArgs([Arg.collection(a.tracks.map((k) => buildArgs([Arg.long(BigInt(k))])))]), library(c)), 20000);
    } else if (a.album) {
      const al = await findAlbum(c, a.album);
      res = await short(c.call('Library', 'GetTrackExportInfoForAlbums', [{ type: 'IEnumerable<AlbumBase>', name: 'albums' }, cb],
        buildArgs([Arg.collection([buildArgs([Arg.ref(al.oid)])])]), library(c)), 20000);
    } else if (a.artist) {
      const p = await performer(c, a.artist);
      res = await short(c.call('Library', 'GetTrackExportInfoForPerformers', [{ type: 'IEnumerable<PerformerBase>', name: 'performers' }, cb],
        buildArgs([Arg.collection([buildArgs([Arg.ref(p.$ref)])])]), library(c)), 30000);
    } else throw new RoonError('Give an album key, an artist key or track keys', 'invalid');
    if (!res?.success) throw new RoonError(`Roon refused the file list (${res?.status ?? 'no answer'})`);
    if (res.payload.length < 2) return { tracks: [] };
    // IList<TrackExportInfo>: structs by value, like the histogram lists of Focus (focus.ts › panelList).
    const r = new BinaryReader(Uint8Array.from(res.payload)); r.integer(); const n = r.flexInt();
    const graph = c.graph as Any;   // readValue isn't part of the graph's public surface
    const infos: Any[] = [];
    for (let i = 0; i < n && r.remaining > 0; i++) infos.push(graph.readValue(r, 23));
    await untilLoaded(c, infos.map((x) => field(x, 'Track')).filter(isRef), 3000);
    const paden = (x: Any): string[] => items(c, field(x, 'DuplicateTracks')).map((d) => field(d, 'FilePath')).filter((p): p is string => typeof p === 'string' && !!p);
    const tracks = infos.map((x) => {
      const t = obj(c, field(x, 'Track'));
      const row: Any = { key: String(field(t, 'TrackId') ?? '') };
      const title = field(t, 'Title'); if (title) row.title = title;
      const al = field(obj(c, field(t, 'Album')), 'Title'); if (al) row.album = al;
      const n2 = field(t, 'TrackNumber'); if (n2 != null) row.n = n2;
      const path = field(x, 'FilePath'); if (typeof path === 'string' && path) row.path = path;
      const format = field(t, 'Format'); if (format) row.format = format;
      const dup = paden(x); if (dup.length) row.duplicates = dup;
      return row;
    });
    // Roon leaves out what has no file (a streaming track): say so, instead of a silently shorter list.
    const gevraagd = a.tracks?.length ?? 0, ontbreekt = gevraagd ? gevraagd - tracks.length : 0;
    const zonder = tracks.filter((t) => !t.path).length + Math.max(0, ontbreekt);
    const of = gevraagd || tracks.length;
    return { tracks, ...(zonder ? { note: `${zonder} of ${of} ${of === 1 ? 'track' : 'tracks'} ${zonder === 1 ? 'has' : 'have'} no file (streaming tracks, or not on this Core's storage)` } : {}) };
  });
}
