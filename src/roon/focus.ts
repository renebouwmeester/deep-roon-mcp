// Roon's Focus: the library's albums, tracks, artists and works, filtered and sorted (Library::Virtual<Kind>Query), and
// the Focus panel with its counts (Library::GetAlbumQueryInfo). Also one work with its recordings in the library.
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { BinaryReader } from '../intern/proto/reader';
import { BinaryWriter } from '../intern/proto/writer';
import { formatMethodSignature } from '../intern/catalog/signature';
import { structSchema } from '../intern/generated/struct-schemas';
import { withCore, RoonError } from '../core/session';
import { ALBUM_TYPES, Any, C, albumRow, duration, field, imageKeys, items, obj, resultRow, short, untilField, untilLoaded, wait, yearOf } from './graph';
import { choose, entityText } from './library';
import { chooseLocations, locationName, type LocationInfo } from './locations';

export interface Filters {
  min_stars?: number; genre?: string; label?: string; artist?: string; composer?: string; producer?: string;
  year_from?: number; year_to?: number; hires?: boolean; live?: boolean; compilation?: boolean; picks?: boolean;
  text?: string; favorites?: boolean; played_within_days?: number; not_played_within_days?: number; added_within_days?: number;
  sample_rate?: string; bits?: string; mqa?: boolean;   // 13 Oct 2026, Rosso's Focus: "44.1, 96" (kHz), "16, 24"
  album_type?: string; exclude_album_type?: string; bootleg?: boolean;   // 22 Oct 2026: Focus' Album Type (main, single, ep …) and bootlegs
  storage?: string;   // where the albums live: "local" (every local folder), "tidal", "qobuz", or a storage location's shown name
  hidden?: 'include' | 'only';   // 29 Oct 2026, Stacks: the albums Roon hides (mostly the lesser copy of a duplicate) — also, or only those
  identified?: boolean;
  exclude_producer?: string;   // 19 Nov 2026, René: "which ECM albums did Manfred Eicher NOT produce" — Roon's ExcludeProduction   // 19 Nov 2026, forum (J): Roon's Identified / Unidentified filter — false lists the unidentified albums
}
interface Member { name: string; propType: number; value: Buffer }
/** "main release", "EP", "singles" … → Roon's AlbumType number (-1: unknown name). */
function albumTypeOf(x: string): number {
  const k = x.toLowerCase().replace(/releases?|s$/g, '').replace(/[^a-z]/g, '');
  const alias: Record<string, string> = { mainrelease: 'main', album: 'main', extendedplay: 'ep', ost: 'soundtrack' };
  return ALBUM_TYPES.indexOf((alias[k] ?? k) as typeof ALBUM_TYPES[number]);
}

// Values as the criteria structs want them: a length prefix around a list, an int? with its presence byte.
const intList = (xs: number[]) => { const w = new BinaryWriter().flexInt(xs.length); for (const x of xs) w.integer(x); const b = w.toBuffer(); return new BinaryWriter().integer(b.length).bytes(b).toBuffer(); };
const textList = (xs: string[]) => { const w = new BinaryWriter().flexInt(xs.length); for (const x of xs) w.string(x); const b = w.toBuffer(); return new BinaryWriter().integer(b.length).bytes(b).toBuffer(); };
const locationInfo = (c: C, v: Any): LocationInfo => {
  const o = obj(c, v);
  return { ref: v.$ref, name: String(field(o, 'Name') ?? ''), displayName: String(field(o, 'DisplayName') ?? ''), category: Number(field(o, 'Category') ?? 0) };
};
const refList = (xs: bigint[]) => { const w = new BinaryWriter().flexInt(xs.length); for (const x of xs) w.long(x); const b = w.toBuffer(); return new BinaryWriter().integer(b.length).bytes(b).toBuffer(); };
const maybeInt = (n: number) => new BinaryWriter().boolean(true).integer(n).toBuffer();
const dateValue = (y: number, m: number, d: number) => { const b = new BinaryWriter().flexInt((y << 16) | (m << 8) | d).toBuffer(); return new BinaryWriter().integer(b.length).bytes(b).toBuffer(); };
const yes = (name: string): Member => ({ name, propType: 2, value: new BinaryWriter().boolean(true).toBuffer() });
const text = (name: string, t: string): Member => ({ name, propType: 20, value: new BinaryWriter().string(t).toBuffer() });
const names = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
const english = (): Member => text('UiLanguage', 'en');

/** A virtual query: the page doesn't come in the query itself but as fresh VirtualQueryElement<…> objects in the graph,
 *  in order, each with Data → the item. Page and query are released again; `offset` rounds down to a page boundary. */
async function virtualQuery(c: C, kind: 'Album' | 'Track' | 'Performer' | 'Work', members: Member[], limit: number, offset: number, row: (o: Any) => Any) {
  const schema = structSchema(`Sooloos.Broker.Api.${kind}QueryCriteria`) ?? [];
  const missing = members.find((f) => !schema.some((m) => m.shortName === f.name));
  if (missing) throw new RoonError(`The filter ${missing.name} doesn't exist for ${kind.toLowerCase()}s in this Roon version`, 'invalid');
  const size = Math.min(Math.max(1, limit), 100), page = Math.floor(Math.max(0, offset) / size);
  const criteria = c.structArg(`Sooloos.Broker.Api.${kind}QueryCriteria`, [english(), ...members]);
  const params = c.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [{ name: 'PageSize', propType: 0, value: new BinaryWriter().integer(size).toBuffer() }]);
  const res = await c.call('Library', `Virtual${kind}Query`,
    [{ type: 'Sooid', name: 'profileid' }, { type: `${kind}QueryCriteria`, name: 'criteria' }, { type: 'VirtualQueryParameters', name: 'queryparams' }, { type: `ResultCallback<Virtual${kind}LiteQuery>`, name: 'cb_result' }],
    Buffer.concat([buildArgs([Arg.sooid(c.profile())]), criteria, params]), c.serviceOid('Library'));
  if (!res.success) throw new RoonError(`Roon refused the ${kind.toLowerCase()} query (${res.status})`);
  const v = c.graph.decodeReturnValue(Uint8Array.from(res.payload));
  if (!isRef(v)) throw new RoonError(`Roon's ${kind.toLowerCase()} query returned nothing`);
  const qoid = v.$ref, type = `Virtual${kind}LiteQuery`;
  const pageParams = [{ type: 'int', name: 'pagen' }, { type: 'ResultCallback', name: 'cb' }];
  const loaded = (o: Any) => o && (field(o, 'Title') !== undefined || field(o, 'Name') !== undefined);
  try {
    const total = field(c.graph.getObject(qoid), 'Count') ?? 0;
    const expected = Math.max(0, Math.min(size, total - page * size));
    if (!expected) return { total, offset: page * size, rows: [] as Any[] };
    const before = new Set(c.graph.objects.keys());
    await c.call(type, 'RetainPage', pageParams, buildArgs([Arg.int(page)]), qoid);
    const end = Date.now() + 4000; let found: Any[] = [];
    while (Date.now() < end) {
      found = [...c.graph.objects.entries()].filter(([k, o]) => !before.has(k) && /VirtualQueryElement</.test(o.typeName)).map(([, o]) => obj(c, field(o, 'Data')));
      if (found.length >= expected && found.every(loaded)) break;
      await wait(60);
    }
    return { total, offset: page * size, rows: found.filter(loaded).map(row) };
  } finally {
    try { c.remoting.callMethodNoReply(qoid, formatMethodSignature(type, 'ReleasePage', pageParams), buildArgs([Arg.int(page)])); } catch { /* released already */ }
    try { c.remoting.callMethodNoReply(qoid, formatMethodSignature(type, 'Dispose', []), Buffer.alloc(0)); } catch { /* disposed already */ }
  }
}

/** The Focus panel for a set of criteria: the count and the histograms per genre, label, artist, year, format … */
async function albumInfo(c: C, members: Member[]): Promise<Any> {
  const criteria = c.structArg('Sooloos.Broker.Api.AlbumQueryCriteria', [english(), ...members]);
  const res = await c.call('Library', 'GetAlbumQueryInfo', [{ type: 'Sooid', name: 'profileid' }, { type: 'AlbumQueryCriteria', name: 'criteria' }, { type: 'ResultCallback<AlbumQueryInfo>', name: 'cb_result' }],
    Buffer.concat([buildArgs([Arg.sooid(c.profile())]), criteria]), c.serviceOid('Library'));
  if (!res.success) throw new RoonError(`Roon refused the Focus panel (${res.status})`);
  const v = c.graph.decodeReturnValue(Uint8Array.from(res.payload));
  if (!isRef(v)) throw new RoonError('Roon returned no Focus panel');
  const end = Date.now() + 3000;
  while (Date.now() < end && field(c.graph.getObject(v.$ref), 'FilteredTotalCount') === undefined) await wait(40);
  return c.graph.getObject(v.$ref);
}

/** One list of the panel by text (AlbumQueryInfo::GetLabels / GetPerformers / GetComposers / GetProduction / GetGenres):
 *  HistogramItem structs by value, {Value, Count}. */
const PANEL: Record<string, [string, string]> = { labels: ['GetLabels', 'string'], artists: ['GetPerformers', 'PerformerLite'], composers: ['GetComposers', 'PerformerLite'], producers: ['GetProduction', 'PerformerLite'], genres: ['GetGenres', 'GenreLite'] };
async function panelList(c: C, info: Any, what: string, search: string): Promise<{ ref: bigint | null; name: string; n: number }[]> {
  const [method, type] = PANEL[what];
  const res = await c.call('AlbumQueryInfo', method, [{ type: 'string', name: 'textfilter' }, { type: `ResultCallback<IList<HistogramItem<${type}>>>`, name: 'cb_result' }], buildArgs([Arg.str(search)]), info.oid);
  if (!res.success) throw new RoonError(`Roon refused the ${what} list (${res.status})`);
  if (res.payload.length < 2) return [];
  const r = new BinaryReader(Uint8Array.from(res.payload)); r.integer(); const n = r.flexInt(); const raw: { value: Any; n: number }[] = [];
  const graph = c.graph as Any;   // readValue isn't part of the graph's public surface
  for (let i = 0; i < n && r.remaining > 0; i++) { const it = graph.readValue(r, 23); raw.push({ value: field(it, 'Value'), n: field(it, 'Count') ?? 0 }); }
  await untilLoaded(c, raw.map((x) => x.value).filter(isRef), 1500);
  return raw.map((x) => ({ ref: isRef(x.value) ? x.value.$ref : null, name: isRef(x.value) ? field(obj(c, x.value), 'Name') : x.value, n: x.n }))
    .filter((x) => x.name).sort((a, b) => b.n - a.n);
}

/** Focus's filters from the arguments. An artist, composer or producer is looked up by name in the panel of the whole
 *  library (the criteria want the object); `matched` says who it became ("jarrett" → Keith Jarrett). */
async function focusMembers(c: C, f: Filters, people: ('artist' | 'composer' | 'producer')[] = ['artist', 'composer', 'producer']) {
  const m: Member[] = [];
  const matched: Record<string, string> = {};
  if (f.min_stars !== undefined) {
    const min = Math.ceil(f.min_stars * 2);
    if (!(min >= 1 && min <= 10)) throw new RoonError('min_stars is 0.5 to 5', 'invalid');
    m.push({ name: 'RequireRatings', propType: 23, value: intList(Array.from({ length: 11 - min }, (_, i) => min + i)) });   // Roon's rating 1–10 = half stars
  }
  if (f.favorites) m.push(yes('RequireIsFavorite'));
  if (f.hidden) m.push(yes('IncludeHidden'));
  if (f.hidden === 'only') m.push(yes('RequireHidden'));
  if (f.text) m.push(text('TextFilter', f.text));
  if (f.genre) m.push({ name: 'RequireGenres', propType: 23, value: textList(names(f.genre)) });
  if (f.label) m.push({ name: 'RequireLabels', propType: 23, value: textList(names(f.label)) });
  if (f.played_within_days) m.push({ name: 'RequirePlayedInLastNDays', propType: 10, value: maybeInt(f.played_within_days) });
  if (f.not_played_within_days) m.push({ name: 'ExcludePlayedInLastNDays', propType: 10, value: maybeInt(f.not_played_within_days) });
  if (f.added_within_days) m.push({ name: 'RequireImportedInLastNDays', propType: 10, value: maybeInt(f.added_within_days) });
  if (f.hires) m.push({ name: 'RequireSampleRates', propType: 23, value: intList([88200, 96000, 176400, 192000, 352800, 384000]) });
  if (f.sample_rate) {
    const hz = names(f.sample_rate).map((x) => Math.round(parseFloat(x) * (parseFloat(x) < 1000 ? 1000 : 1))).filter((x) => x > 0);
    if (hz.length) m.push({ name: 'RequireSampleRates', propType: 23, value: intList(hz) });
  }
  if (f.bits) { const b = names(f.bits).map(Number).filter((x) => x > 0); if (b.length) m.push({ name: 'RequireBitsPerSample', propType: 23, value: intList(b) }); }
  if (f.mqa === true) m.push(yes('RequireIsMQA')); else if (f.mqa === false) m.push(yes('ExcludeIsMQA'));
  if (f.storage) {
    // The Location objects come from the panel of the whole library ("TIDAL Library", "qobuz Library", and a number for
    // local files — measured 13 Oct 2026); the criteria want the objects.
    const whole = await albumInfo(c, []);
    const locs = items(c, field(whole, 'Locations')).map((it) => field(it, 'Value')).filter(isRef);
    await untilLoaded(c, locs, 1500);
    const known = locs.map((v) => locationInfo(c, v));
    const hits = chooseLocations(known, f.storage);
    if (!hits.length) throw new RoonError(`No "${f.storage}" in this library's locations: ${known.map(locationName).join(', ')}`, 'not_found');
    m.push({ name: 'RequireLocations', propType: 23, value: refList(hits) });
  }
  if (f.live === true) m.push(yes('RequireIsLive')); else if (f.live === false) m.push(yes('ExcludeIsLive'));
  if (f.compilation === true) m.push(yes('RequireIsCompilation')); else if (f.compilation === false) m.push(yes('ExcludeIsCompilation'));
  if (f.picks) m.push(yes('RequireIsPick'));
  if (f.bootleg === true) m.push(yes('RequireIsBootleg')); else if (f.bootleg === false) m.push(yes('ExcludeIsBootleg'));
  if (f.identified === true) m.push(yes('RequireIsIdentified')); else if (f.identified === false) m.push(yes('ExcludeIsIdentified'));
  for (const [arg, member] of [[f.album_type, 'RequireTypes'], [f.exclude_album_type, 'ExcludeTypes']] as const) {
    if (!arg) continue;
    const want = names(arg).map((x) => albumTypeOf(x));
    const bad = want.findIndex((x) => x < 0);
    if (bad >= 0) throw new RoonError(`album type "${names(arg)[bad]}": choose from ${ALBUM_TYPES.join(', ')}`, 'invalid');
    m.push({ name: member, propType: 23, value: intList(want) });
  }
  if (f.year_from && f.year_from > 1000) m.push({ name: 'MinDate', propType: 23, value: dateValue(f.year_from, 0, 0) });
  if (f.year_to && f.year_to > 1000) m.push({ name: 'MaxDate', propType: 23, value: dateValue(f.year_to, 12, 31) });
  const wanted = ([['artist', 'artists', 'RequirePerformers'], ['composer', 'composers', 'RequireComposers'], ['producer', 'producers', 'RequireProduction']] as const)
    .filter(([p]) => people.includes(p) && f[p]);
  if (wanted.length) {
    const whole = await albumInfo(c, []);
    for (const [p, list, member] of wanted) {
      const want = String(f[p]);
      const l = await panelList(c, whole, list, want);
      const hit = l.find((x) => String(x.name).toLowerCase() === want.toLowerCase()) ?? l[0];
      if (!hit || hit.ref === null) throw new RoonError(`No ${p} "${want}" in the library`, 'not_found');
      m.push({ name: member, propType: 23, value: refList([hit.ref]) });
      matched[p] = hit.name;
    }
  }
  // Leaving a producer out (ExcludeProduction): looked up the same way, in the producers of the whole library.
  if (f.exclude_producer && people.includes('producer')) {
    const want = f.exclude_producer;
    const l = await panelList(c, await albumInfo(c, []), 'producers', want);
    const hit = l.find((x) => String(x.name).toLowerCase() === want.toLowerCase()) ?? l[0];
    if (!hit || hit.ref === null) throw new RoonError(`No producer "${want}" in the library`, 'not_found');
    m.push({ name: 'ExcludeProduction', propType: 23, value: refList([hit.ref]) });
    matched.excluded_producer = hit.name;
  }
  return { members: m, matched: Object.keys(matched).length ? matched : undefined };
}

function ordering(c: C, kind: string, table: Record<string, number>, sort: string | undefined, ascending: boolean | undefined, descendingByDefault: string[]): Member[] {
  if (sort === undefined && ascending === undefined) return [];
  const o = table[sort ?? Object.keys(table)[0]];
  if (o === undefined) throw new RoonError(`sort: choose from ${Object.keys(table).join(', ')}`, 'invalid');
  const members: Member[] = [{ name: 'Ordering', propType: 9, value: new BinaryWriter().flexInt(o).toBuffer() }];
  const asc = ascending ?? (sort && descendingByDefault.includes(sort) ? false : undefined);
  if (asc !== undefined) members.push({ name: 'Direction', propType: 9, value: new BinaryWriter().flexInt(asc ? 1 : 2).toBuffer() });
  if (sort === 'random') members.push({ name: 'RandomSeed', propType: 0, value: new BinaryWriter().integer(Math.floor(Math.random() * 0x7fffffff)).toBuffer() });
  return [{ name: 'Ordering', propType: 23, value: c.structArg(`Sooloos.Broker.Api.${kind}QueryOrdering`, members) }];
}

// AlbumOrdering, TrackOrdering, PerformerOrdering, WorkOrdering
const ALBUM_ORDER = { artist: 0, added: 1, released: 2, most_played: 3, title: 4, popular: 5, random: 7 };
const TRACK_ORDER = { title: 0, released: 1, most_played: 2, last_played: 3, artist: 4, album: 5, length: 6, added: 7, popular: 14, random: 16 };
const ARTIST_ORDER = { name: 0, albums: 2, works: 3, most_played: 4, popular: 6 };
const WORK_ORDER = { title: 0, composer: 1, composed: 3, period: 4, performances: 5, popular: 9 };

/** Roon's top-level genres (the GENRES of Focus): the names an album's own `genres` list mixes with sub-genres. Read once
 *  from the library's Focus histogram, kept for the life of the process (13 Oct 2026, for the genre filter on a shelf). */
let toplevelNames: Set<string> | null = null;
export async function toplevelGenres(c: C): Promise<Set<string>> {
  if (toplevelNames) return toplevelNames;
  const { members } = await focusMembers(c, {});
  const info = await albumInfo(c, members);
  const hist = items(c, field(info, 'ToplevelGenres')).map((it) => field(it, 'Value'));
  await untilLoaded(c, hist.filter(isRef), 2000);
  const names = hist.map((w) => (isRef(w) ? field(obj(c, w), 'Name') : w)).filter((n): n is string => typeof n === 'string');
  if (names.length) toplevelNames = new Set(names);
  return new Set(names);
}

export async function library(f: Filters, sort: string | undefined, ascending: boolean | undefined, limit: number, offset: number) {
  return withCore(async (c) => {
    const { members, matched } = await focusMembers(c, f);
    members.push(...ordering(c, 'Album', ALBUM_ORDER, sort, ascending, ['added', 'released', 'most_played', 'popular']));   // newest first (13 Oct 2026)
    const out = await virtualQuery(c, 'Album', members, limit, offset, (o) => albumRow(c, o));
    return { ...out, matched };
  });
}

export async function focus(f: Filters, more: string | undefined, search: string | undefined, limit: number) {
  if (more !== undefined && !PANEL[more]) throw new RoonError(`more: choose from ${Object.keys(PANEL).join(', ')}`, 'invalid');
  return withCore(async (c) => {
    const { members, matched } = await focusMembers(c, f);
    const info = await albumInfo(c, members);
    const total = field(info, 'FilteredTotalCount') ?? 0;
    if (more) { const l = await panelList(c, info, more, search ?? ''); return { total_albums: total, matched, list: more, count: l.length, rows: l.slice(0, limit).map((x) => ({ name: x.name, albums: x.n })) }; }
    const hist = (name: string) => items(c, field(info, name)).map((it) => ({ w: field(it, 'Value'), n: field(it, 'Count') ?? 0 }));
    await untilLoaded(c, ['ToplevelGenres', 'AllGenres', 'Performers', 'Composers', 'Production'].flatMap((k) => hist(k).map((x) => x.w)).filter(isRef), 2000);
    const byName = (name: string, max = 20) => hist(name).map((x) => ({ name: isRef(x.w) ? field(obj(c, x.w), 'Name') : x.w, albums: x.n })).filter((x) => x.name).sort((a, b) => b.albums - a.albums).slice(0, max);
    const numbers = (name: string) => hist(name).filter((x) => typeof x.w === 'number').sort((a, b) => b.n - a.n);
    const top = new Set(byName('ToplevelGenres', 50).map((x) => x.name));
    const decades = new Map<number, number>(); for (const x of numbers('Years')) { const d = Math.floor(x.w / 10) * 10; decades.set(d, (decades.get(d) ?? 0) + x.n); }
    const years = numbers('Years');
    return {
      total_albums: total, matched,
      genres: byName('ToplevelGenres'), sub_genres: byName('AllGenres', 60).filter((x) => !top.has(x.name)).slice(0, 20),
      labels: byName('Labels'), artists: byName('Performers'), composers: byName('Composers'), producers: byName('Production'),
      decades: [...decades].sort((a, b) => a[0] - b[0]).map(([d, n]) => ({ decade: `${d}s`, albums: n })),
      years: years.length <= 15 ? years.sort((a, b) => a.w - b.w).map((x) => ({ year: x.w, albums: x.n })) : undefined,
      stars: hist('Ratings').map((x) => ({ stars: typeof x.w === 'number' ? x.w / 2 : 'unrated', albums: x.n })),
      sample_rates: numbers('SampleRate').map((x) => ({ rate: `${x.w / 1000} kHz`, albums: x.n })),
      bit_depths: numbers('BitsPerSample').map((x) => ({ bits: x.w, albums: x.n })),
      live: field(info, 'IsLiveCount') ?? 0, compilations: field(info, 'IsCompilationCount') ?? 0, roon_picks: field(info, 'IsPickCount') ?? 0,
      mqa: field(info, 'IsMQACount') ?? 0,
      // Roon's album types (main release, single, EP, soundtrack …); the default, main, comes without a value.
      album_types: hist('Types').map((x) => ({ type: ALBUM_TYPES[typeof x.w === 'number' ? x.w : 0] ?? 'unknown', albums: x.n })).sort((a, b) => b.albums - a.albums),
      // Raw histograms, to be named once measured (13 Oct 2026): where the albums live, and their file formats.
      storage: hist('Locations').map((x) => ({ name: isRef(x.w) ? locationName(locationInfo(c, x.w)) : String(x.w), albums: x.n })),
    };
  });
}

export interface TrackFilters { text?: string; title?: string; genre?: string; label?: string; artist?: string; composer?: string; favorites?: boolean; live?: boolean;
  year_from?: number; year_to?: number; played_within_days?: number; not_played_within_days?: number; added_within_days?: number }
export async function tracks(f: TrackFilters, sort: string | undefined, ascending: boolean | undefined, limit: number, offset: number) {
  return withCore(async (c) => {
    const { members, matched } = await focusMembers(c, { genre: f.genre, label: f.label, artist: f.artist, composer: f.composer, favorites: f.favorites, live: f.live, year_from: f.year_from, year_to: f.year_to,
      played_within_days: f.played_within_days, not_played_within_days: f.not_played_within_days, added_within_days: f.added_within_days, text: f.text }, ['artist', 'composer']);
    if (f.title) members.push(text('TrackTitleTextFilter', f.title));
    members.push(...ordering(c, 'Track', TRACK_ORDER, sort, ascending, ['released', 'most_played', 'last_played', 'added', 'popular']));
    const out = await virtualQuery(c, 'Track', members, limit, offset, (o) => resultRow(c, o));
    return { ...out, matched };
  });
}

export async function artists(f: { text?: string; genre?: string; country?: string; period?: string; composers?: boolean; classical?: boolean }, sort: string | undefined, ascending: boolean | undefined, limit: number, offset: number) {
  return withCore(async (c) => {
    const m: Member[] = [];
    if (f.classical) m.push(yes('RequireIsClassicalComposer')); else if (f.composers) m.push(yes('RequireIsComposer')); else m.push(yes('RequireIsMainPerformer'));
    if (f.text) m.push(text('TextFilter', f.text));
    if (f.genre) m.push({ name: 'RequireGenres', propType: 23, value: textList(names(f.genre)) });
    if (f.country) m.push({ name: 'RequireCountries', propType: 23, value: textList([f.country]) });
    if (f.period) m.push({ name: 'RequirePeriods', propType: 23, value: textList([f.period]) });
    // Composers count plays and popularity in their own fields.
    const table = f.composers || f.classical ? { ...ARTIST_ORDER, most_played: 5, popular: 7 } : ARTIST_ORDER;
    m.push(...ordering(c, 'Performer', table, sort, ascending, ['albums', 'works', 'most_played', 'popular']));
    return virtualQuery(c, 'Performer', m, limit, offset, (o) => {
      const r = resultRow(c, o); delete r.kind;
      const w = field(o, 'WorkCount'); if (typeof w === 'number' && w > 0) r.works = w;
      return r;
    });
  });
}

function workRow(c: C, w: Any): Any {
  const r: Any = { key: String(field(w, 'WorkId') ?? ''), title: field(w, 'Title') ?? '', composers: items(c, field(w, 'Composers')).map((p) => field(p, 'Name')).filter(Boolean) };
  const period = field(w, 'Period'); if (period) r.period = period;
  const form = field(w, 'Form'); if (form) r.form = form;
  const y = yearOf(field(w, 'CompositionEndDate')) ?? yearOf(field(w, 'CompositionStartDate')); if (y) r.year = y;
  const l = field(w, 'LengthSeconds'); if (typeof l === 'number' && l > 0) r.length = duration(l);
  const n = field(w, 'PerformanceCount'); if (typeof n === 'number') r.performances = n;
  const imgs = imageKeys(c, w); if (imgs.length) r.images = imgs;   // the covers of its recordings (13 Oct 2026)
  return r;
}

export async function works(f: { composer?: string; text?: string; period?: string; form?: string; instrumentation?: string; classical?: boolean }, sort: string | undefined, ascending: boolean | undefined, limit: number, offset: number) {
  return withCore(async (c) => {
    const m: Member[] = [];
    if (f.text) m.push(text('TextFilter', f.text));
    if (f.composer) m.push(text('WorkComposerTextFilter', f.composer));
    if (f.period) m.push(text('WorkPeriodTextFilter', f.period));
    if (f.form) m.push(text('WorkFormTextFilter', f.form));
    if (f.instrumentation) m.push(text('WorkInstrumentationTextFilter', f.instrumentation));
    if (f.classical) m.push(yes('RequireHasClassicalComposer'));
    m.push(...ordering(c, 'Work', WORK_ORDER, sort, ascending, ['performances', 'popular']));
    return virtualQuery(c, 'Work', m, limit, offset, (o) => workRow(c, o));
  });
}

/** One work: Roon's description (as with reviews), its movements, and the performances in the library with their track
 *  keys (Work::GetPerformances with source Local; for Qobuz the same question gave nothing — measured). */
export async function work(key: string, max: number, wiki: boolean) {
  if (!/^\d+$/.test(key)) throw new RoonError('A work key is a number', 'invalid');
  return withCore(async (c) => {
    const light = await short(c.call('Library', 'GetWorkLite', [{ type: 'long', name: 'workid' }, { type: 'ResultCallback<WorkLite>', name: 'cb_result' }], buildArgs([Arg.long(BigInt(key))]), c.serviceOid('Library')));
    const lv = light?.success && light.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(light.payload)) : null;
    if (!isRef(lv) || (await untilField(c, lv.$ref, 'Title', 2000)) === undefined) throw new RoonError(`Roon knows no work with key ${key}`, 'not_found');
    const res = await short(c.call('Library', 'GetWork', [{ type: 'WorkBase', name: 'work' }, { type: 'ResultCallback<Work>', name: 'cb_result' }], buildArgs([Arg.ref(lv.$ref)]), c.serviceOid('Library')), 6000);
    const v = res?.success && res.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(res.payload)) : null;
    if (!isRef(v)) throw new RoonError('Roon doesn\'t give the full work');
    const external = await untilField(c, v.$ref, 'ExternalWorkId');
    const texts = choose(await entityText(c, external, key, 'description', ['Rovi-compositions:en', 'Wikipedia:en']), max, wiki);
    const crit = c.structArg('Sooloos.Broker.Api.WorkPerformanceQueryCriteria', [english()]);
    const rp = await short(c.call('Work', 'GetPerformances',
      [{ type: 'Sooid', name: 'profileid' }, { type: 'MediaSource', name: 'source' }, { type: 'GetPerformancesMode', name: 'mode' }, { type: 'WorkPerformanceQueryCriteria', name: 'criteria' }, { type: 'ResultCallback<Query<Performance>>', name: 'cb_result' }],
      Buffer.concat([buildArgs([Arg.sooid(c.profile()), Arg.enum_(1), Arg.enum_(0)]), crit]), v.$ref), 8000);
    const qv = rp?.success && rp.payload.length ? c.graph.decodeReturnValue(Uint8Array.from(rp.payload)) : null;
    let perfs: Any[] = [];
    if (isRef(qv)) {
      const end = Date.now() + 3000;
      while (Date.now() < end) { perfs = items(c, qv); if (perfs.length && perfs.every((p) => { const t = items(c, field(p, 'Tracks')); return t.length && t.every((x) => field(x, 'Title') !== undefined); })) break; await wait(60); }
    }
    const W = c.graph.getObject(v.$ref);
    const movements = items(c, field(W, 'Parts')).map((p) => field(p, 'Title')).filter(Boolean);
    return {
      work: workRow(c, c.graph.getObject(lv.$ref)), movements: movements.length ? movements : undefined, texts,
      performances: perfs.map((p) => {
        const trs = items(c, field(p, 'Tracks')); const al = obj(c, field(trs[0], 'Album'));
        const l = field(p, 'LengthSeconds');
        return { album: al && field(al, 'Title') !== undefined ? albumRow(c, al) : undefined, length: typeof l === 'number' ? duration(l) : undefined,
                 tracks: trs.map((t) => ({ key: String(field(t, 'TrackId') ?? ''), title: field(t, 'Title'), length: typeof field(t, 'LengthSeconds') === 'number' ? duration(field(t, 'LengthSeconds')) : undefined })) };
      }),
    };
  });
}
