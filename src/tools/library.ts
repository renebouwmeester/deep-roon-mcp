// The library and Home tools: Focus on albums, tracks, artists and works; the Focus panel; Daily Picks, New releases
// for you and the Daily Mixes; playlists; favourites and Listen Later; other versions and more like this; Roon's signal
// path; MUSE.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fc from '../roon/focus';
import * as home from '../roon/home';
import * as more from '../roon/more';
import * as rd from '../roon/radio';
import * as tidal from '../roon/tidal';
import { run } from './run';
import { registerPlaylistEditTools } from './playlist-edit';

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const PLAYS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
// Changes the user's library or how a zone sounds: clients may ask for confirmation.
const CHANGES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const zone = z.string().describe('A Roon zone name (see roon_zones).');
const mode = z.enum(['now', 'next', 'queue']).optional().describe('now (default), next, or queue (at the end).');
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).optional().describe(`How many (default ${dflt}, at most ${max}).`);
const offset = z.number().int().min(0).optional().describe('Paging: where to start (in steps of `limit`).');
const days = z.number().int().min(1).optional();

const FOCUS = {
  min_stars: z.number().min(0.5).max(5).optional().describe('Roon\'s album rating, 0.5–5 (5 = only five-star albums).'),
  genre: z.string().optional().describe('A Roon genre name (Jazz, Classical, Pop/Rock, Piano Jazz …); comma-separated for several.'),
  label: z.string().optional().describe('The exact label name, e.g. "ECM Records" (roon_focus lists them).'),
  artist: z.string().optional().describe('A name or part of it.'), composer: z.string().optional(), producer: z.string().optional().describe('Producers and engineers.'),
  year_from: z.number().int().optional(), year_to: z.number().int().optional(),
  hires: z.boolean().optional().describe('Above 48 kHz.'), live: z.boolean().optional(), compilation: z.boolean().optional(), picks: z.boolean().optional().describe('Roon\'s own picks.'),
  text: z.string().optional().describe('A word in the title or artist.'), favorites: z.boolean().optional(),
  sample_rate: z.string().optional().describe('Sample rates in kHz, comma-separated: "44.1, 96".'), bits: z.string().optional().describe('Bit depths, comma-separated: "16, 24".'), mqa: z.boolean().optional(),
  storage: z.enum(['tidal', 'qobuz', 'local']).optional().describe('Where the albums live.'),
  album_type: z.string().optional().describe('Roon\'s album type, comma-separated: main, single, ep, compilation, soundtrack, show, other.'),
  exclude_album_type: z.string().optional().describe('Album types to leave out, e.g. "single, ep".'),
  bootleg: z.boolean().optional(),
  played_within_days: days, not_played_within_days: days, added_within_days: days,
};
type FocusArgs = { [K in keyof typeof FOCUS]?: z.infer<(typeof FOCUS)[K]> };
const filters = (a: FocusArgs): fc.Filters => ({ ...a });

export function registerLibraryTools(server: McpServer): void {
  // ---- Focus ----
  server.registerTool('roon_library', {
    title: 'Library (Focus)',
    description: 'The user\'s Roon LIBRARY — the albums they own or added — filtered and sorted with Roon\'s Focus. Filters combine freely: `min_stars` (Roon\'s editorial album rating; 5 = only five-star albums — THE tool for "five-star albums in my library"), `genre`, `label`, `artist`, `composer`, `producer`, `year_from` / `year_to`, `hires`, `live`, `compilation`, `picks`, `album_type` / `exclude_album_type` (main, single, ep, compilation, soundtrack, show), `bootleg`, `text`, `favorites`, `played_within_days` / `not_played_within_days` / `added_within_days`. `sort`: artist (default), added, released, most_played, title, popular, random — `random` is the way to "pick something from my library"; `ascending` flips a sort. `total` counts all matches; `offset` pages. Rows carry stars, year, format and a `key` for roon_play / roon_album. `matched` says which artist, composer or producer a name became.',
    inputSchema: { ...FOCUS, sort: z.enum(['artist', 'added', 'released', 'most_played', 'title', 'popular', 'random']).optional(), ascending: z.boolean().optional(), limit: limit(100, 50), offset },
    annotations: READ,
  }, ({ sort, ascending, limit: n, offset: o, ...f }) => run(() => fc.library(filters(f), sort, ascending, n ?? 50, o ?? 0)));

  server.registerTool('roon_focus', {
    title: 'Focus panel',
    description: 'Roon\'s Focus panel: what the library — or a filtered part of it — is MADE OF, with counts: genres and sub-genres, labels, artists, composers, producers, decades, star ratings, sample rates and bit depths, live albums, compilations, album types (main release, single, EP, soundtrack …), Roon\'s picks. Same filters as roon_library ("what labels are my five-star albums on", "which decades is my ECM collection from"). Use it for questions ABOUT the library and to find exact genre or label names for roon_library. The panel shows the top twenty of each list; `more` (labels, artists, composers, producers, genres) returns one list in full, optionally narrowed by `search`.',
    inputSchema: { ...FOCUS, more: z.enum(['labels', 'artists', 'composers', 'producers', 'genres']).optional(), search: z.string().optional().describe('With `more`: only names containing this.'), limit: limit(200, 40) },
    annotations: READ,
  }, ({ more: m, search, limit: n, ...f }) => run(() => fc.focus(filters(f), m, search, n ?? 40)));

  server.registerTool('roon_tracks', {
    title: 'Tracks in the library',
    description: 'The TRACKS in the user\'s Roon library, filtered and sorted (Focus on tracks) — each with a `key` for roon_play_tracks. Filters: `text`, `title`, `genre`, `label`, `artist`, `composer`, `favorites`, `live`, `year_from` / `year_to`, `played_within_days` / `not_played_within_days` / `added_within_days`. `sort`: title (default), most_played, last_played, released, added, artist, album, length, popular, random; `ascending` flips it. For "my most played tracks", "twenty random jazz tracks from my library" (sort: random, then roon_play_tracks), "tracks I haven\'t heard in a year".',
    inputSchema: { text: z.string().optional(), title: z.string().optional(), genre: z.string().optional(), label: z.string().optional(), artist: z.string().optional(), composer: z.string().optional(),
      favorites: z.boolean().optional(), live: z.boolean().optional(), year_from: z.number().int().optional(), year_to: z.number().int().optional(),
      played_within_days: days, not_played_within_days: days, added_within_days: days,
      sort: z.enum(['title', 'most_played', 'last_played', 'released', 'added', 'artist', 'album', 'length', 'popular', 'random']).optional(), ascending: z.boolean().optional(), limit: limit(100, 50), offset },
    annotations: READ,
  }, ({ sort, ascending, limit: n, offset: o, ...f }) => run(() => fc.tracks(f, sort, ascending, n ?? 50, o ?? 0)));

  server.registerTool('roon_artists', {
    title: 'Artists in the library',
    description: 'The ARTISTS in the user\'s Roon library (Focus on artists), each with a `key` for roon_artist, roon_bio and roon_similar, the number of albums and of works they wrote. `composers: true` lists composers instead; `classical: true` only classical composers. Filters: `text` (part of the name), `genre`, `country`, `period` (for composers: Baroque, Romantic …). `sort`: name (default), most_played, albums, works, popular; `ascending` flips it.',
    inputSchema: { text: z.string().optional(), genre: z.string().optional(), country: z.string().optional(), period: z.string().optional(), composers: z.boolean().optional(), classical: z.boolean().optional(),
      sort: z.enum(['name', 'most_played', 'albums', 'works', 'popular']).optional(), ascending: z.boolean().optional(), limit: limit(100, 50), offset },
    annotations: READ,
  }, ({ sort, ascending, limit: n, offset: o, ...f }) => run(() => fc.artists(f, sort, ascending, n ?? 50, o ?? 0)));

  server.registerTool('roon_works', {
    title: 'Works (compositions)',
    description: 'The WORKS (compositions) in the user\'s Roon library — the classical way in: a work is the piece itself ("Goldberg Variations, BWV 988"), apart from its recordings. Filters: `composer`, `text`, `period`, `form` (Sonata, Suite …), `instrumentation`, `classical: true` (only works by classical composers). `sort`: title (default), composer, composed, performances (how many recordings in the library), popular. Rows carry composers, period, form, year, length, `performances` and a `key` for roon_work.',
    inputSchema: { composer: z.string().optional(), text: z.string().optional(), period: z.string().optional(), form: z.string().optional(), instrumentation: z.string().optional(), classical: z.boolean().optional(),
      sort: z.enum(['title', 'composer', 'composed', 'performances', 'popular']).optional(), ascending: z.boolean().optional(), limit: limit(100, 50), offset },
    annotations: READ,
  }, ({ sort, ascending, limit: n, offset: o, ...f }) => run(() => fc.works(f, sort, ascending, n ?? 50, o ?? 0)));

  server.registerTool('roon_work', {
    title: 'One work',
    description: 'One work (by `key` from roon_works): Roon\'s description of the piece with its author, its movements, and the `performances` in the library — each with the album (and its key) and the tracks with their keys, so one recording can be played with roon_play_tracks. Like a review, show the description complete as returned. `wikipedia: true` adds the Wikipedia text.',
    inputSchema: { key: z.string().describe('A work key.'), wikipedia: z.boolean().optional(), max_chars: z.number().int().min(200).optional() },
    annotations: READ,
  }, ({ key, wikipedia, max_chars }) => run(() => fc.work(key, max_chars ?? 1e9, wikipedia === true)));

  // ---- Home ----
  server.registerTool('roon_daily_picks', {
    title: 'Daily Picks',
    description: 'Roon\'s Daily Picks from the Home screen — today\'s personal recommendations, in boxes. Each box has its `kind`, its `reason` (new_release; recent = from what was played lately; all_time = from long-term listening) and `because_you_played` — the album the box is built on — plus the recommended albums with a `key`. `limit` is per box (default 8). THE tool for "what does Roon recommend today", "my daily picks".',
    inputSchema: { limit: limit(30, 8) },
    annotations: READ,
  }, ({ limit: n }) => run(() => home.dailyPicks(n ?? 8)));

  server.registerTool('roon_mix', {
    title: 'A Daily Mix\'s tracks',
    description: 'The tracks inside one of Roon\'s Daily Mixes (by `key` or name from roon_mixes), as Roon\'s mix page shows them before playing — each with a `key` for roon_play_tracks. To play the whole mix, roon_play_mix.',
    inputSchema: { key: z.string().describe('A mix key or its name, from roon_mixes.'), limit: limit(300, 100) },
    annotations: READ,
  }, ({ key, limit: n }) => run(() => home.mix(key, n ?? 100)));

  server.registerTool('roon_new_for_you', {
    title: 'New releases for you',
    description: '"New releases for you" from Roon\'s Home: new albums Roon picked for this user, from the artists and music they listen to — personal, unlike roon_new (the streaming services\' editorial shelf, the same for everyone). Use it for "my new releases", "what\'s new for me". Albums carry year, format, `genres`, sometimes a `review`, and a `key`; `genres` at the top counts the shelf\'s top-level genres (the choices for `genre`).',
    inputSchema: { limit: limit(100, 30), offset, genre: z.string().optional().describe('Only albums of this genre (a Roon genre name, e.g. Jazz; sub-genres match too).') },
    annotations: READ,
  }, ({ limit: n, offset: o, genre }) => run(() => home.newForYou(n ?? 30, o ?? 0, genre)));

  server.registerTool('roon_mixes', {
    title: 'Daily Mixes',
    description: 'Roon\'s own Daily Mixes, from Roon\'s Home — NOT TIDAL\'s mixes: for "TIDAL mixes", "My Mix", "My Daily Discovery" or TIDAL\'s daily mixes use roon_tidal_playlists with `shelf: "my_mixes"`. These are today\'s personal Roon mixes, each built around an artist (or genre) the user listens to, with a few `touchstones` and a `key` for roon_play_mix. They change every day.',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => home.mixes()));

  server.registerTool('roon_play_mix', {
    title: 'Play a Daily Mix',
    description: 'Play one of today\'s Daily Mixes on a Roon zone (`key` from roon_mixes, or the mix\'s name). `mode`: now (default), next or queue. Only on an explicit request, never as a probe.',
    inputSchema: { key: z.string(), zone, mode },
    annotations: PLAYS,
  }, ({ key, zone: zn, mode: m }) => run(() => home.playMix(key, zn, m ?? 'now')));

  // ---- playlists ----
  registerPlaylistEditTools(server);
  server.registerTool('roon_playlists', {
    title: 'Playlists',
    description: 'The playlists in the user\'s Roon: their own Roon playlists, Qobuz and TIDAL playlists they added, and editorial ones — each with a `key` for roon_playlist and roon_play_playlist, the number of tracks, and whether it is read-only.',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => more.playlists()));

  server.registerTool('roon_tidal_playlists', {
    title: 'TIDAL playlists',
    description: 'TIDAL\'s playlists as Roon shows them, when TIDAL is signed in: the editorial shelves `new`, `recommended`, `exclusive`, `masters`, `popular`, `essential`, `hires_classics`, `recently_updated`, `forgotten_favorites`; the user\'s own TIDAL mixes `my_mixes` (My Daily Discovery, My Mix 1 …, My New Arrivals — what the user means by their TIDAL (daily) mixes; not roon_mixes, which are Roon\'s) and `history_mixes` (My Most Listened, the yearly ones …); or the playlists of one TIDAL `genre` or `mood` (ids from roon_genres with `service: "tidal"`). Each playlist has a `key` for roon_playlist (its tracks — readable without playing) and roon_play_playlist, a description, the number of tracks and a few of its artists.',
    inputSchema: {
      shelf: z.enum(Object.keys(tidal.PLAYLIST_SHELVES) as [string, ...string[]]).optional().describe('Default new.'),
      genre: z.string().optional().describe('A TIDAL genre (roon_genres, service tidal).'), mood: z.string().optional().describe('A TIDAL mood (roon_genres, service tidal).'),
      limit: limit(100, 20), offset,
    },
    annotations: READ,
  }, ({ shelf, genre, mood, limit: n, offset: o }) => run(() => tidal.playlists(shelf ?? 'new', genre, mood, n ?? 20, o ?? 0)));

  server.registerTool('roon_playlist', {
    title: 'A playlist\'s tracks',
    description: 'The tracks of one Roon playlist (by its `key` from roon_playlists or roon_tidal_playlists, or its exact name), each with a `key` for roon_play_tracks.',
    inputSchema: { key: z.string(), limit: limit(300, 100) },
    annotations: READ,
  }, ({ key, limit: n }) => run(() => more.playlist(key, n ?? 100)));

  server.registerTool('roon_play_playlist', {
    title: 'Play a playlist',
    description: 'Play a Roon playlist on a Roon zone (`key` from roon_playlists or roon_tidal_playlists, or its exact name). `mode`: now (default), next or queue. `shuffle: true` starts it shuffled from the very first track (Roon\'s own Shuffle button) — THE way to "shuffle a playlist": one call, no roon_settings, no skip. Only on an explicit request, never as a probe.',
    inputSchema: { key: z.string(), zone, mode, shuffle: z.boolean().optional() },
    annotations: PLAYS,
  }, ({ key, zone: zn, mode: m, shuffle }) => run(() => more.playPlaylist(key, zn, m ?? 'now', shuffle === true)));

  server.registerTool('roon_playlist_create', {
    title: 'Create a playlist',
    description: 'Create a new playlist in Roon from track `keys` (from roon_search with kind track, roon_album, roon_playlist or roon_tracks), in the order given. This saves something in the user\'s Roon library: only on an explicit request ("save this as a playlist called …").',
    inputSchema: { name: z.string().min(1), keys: z.array(z.string()).min(1).max(200) },
    annotations: CHANGES,
  }, ({ name, keys }) => run(() => more.playlistCreate(name, keys)));

  // ---- favourites, Listen Later, the library ----
  server.registerTool('roon_favorites', {
    title: 'Favourite albums',
    description: 'The user\'s favourite albums: `source: "roon"` (default) are the albums with a heart in Roon, newest first; `source: "qobuz"` or `"tidal"` the favourites at that service. Albums carry a `key`.',
    inputSchema: { source: z.enum(['roon', 'qobuz', 'tidal']).optional(), limit: limit(100, 50) },
    annotations: READ,
  }, ({ source, limit: n }) => run(() => more.favorites(source ?? 'roon', n ?? 50)));

  server.registerTool('roon_radio_favorite', {
    title: 'A station in My Live Radio',
    description: 'Put a Live Radio station in the user\'s own list (My Live Radio), or take it out (`on: false`). The `key` comes from roon_radio. Changes the user\'s library: only on an explicit request. Reads the result back.',
    inputSchema: { key: z.string(), on: z.boolean().optional() },
    annotations: CHANGES,
  }, ({ key, on }) => run(() => rd.radioFavorite(key, on !== false)));

  server.registerTool('roon_favorite', {
    title: 'Heart an album or track',
    description: 'Put a heart on an album or a track in Roon, or take it off (`on: false`). The `key` comes from a search, shelf, album or playlist result. Changes the user\'s library: only on an explicit request. Reads the heart back and says if Roon didn\'t change it.',
    inputSchema: { kind: z.enum(['album', 'track']), key: z.string(), on: z.boolean().optional() },
    annotations: CHANGES,
  }, ({ kind, key, on }) => run(() => more.favorite(kind, key, on !== false)));

  server.registerTool('roon_listen_later', {
    title: 'Listen Later',
    description: 'The user\'s Listen Later list in Roon: the albums (and tracks) marked to hear later, newest first, each with a `key`. By default only what still waits; `include_played: true` adds what has been heard since.',
    inputSchema: { include_played: z.boolean().optional() },
    annotations: READ,
  }, ({ include_played }) => run(() => more.listenLater(include_played === true)));

  server.registerTool('roon_listen_later_set', {
    title: 'Listen Later: add or remove',
    description: 'Put an album or a track on the Listen Later list in Roon, or take it off (`on: false`) — the natural thing to offer after recommending something the user can\'t hear right now. Changes the library: only on an explicit request. Reads it back.',
    inputSchema: { kind: z.enum(['album', 'track']), key: z.string(), on: z.boolean().optional() },
    annotations: CHANGES,
  }, ({ kind, key, on }) => run(() => more.listenLaterSet(kind, key, on !== false)));

  server.registerTool('roon_library_add', {
    title: 'Add to the library',
    description: 'Add a Qobuz or TIDAL album to the user\'s Roon library (the album `key` from a search, shelf or discography). Changes the library: only on an explicit request.',
    inputSchema: { key: z.string() },
    annotations: CHANGES,
  }, ({ key }) => run(() => more.libraryAdd(key)));

  // ---- other versions, more like this ----
  server.registerTool('roon_versions', {
    title: 'Other versions',
    description: 'The other versions Roon knows of an album (by album `key`): remasters, deluxe editions, mono/stereo, hi-res — `in_library` and `streaming` (at Qobuz or TIDAL — each row says its `source`), best format first, each with year, format, number of tracks and a `key`. For "is there a hi-res version", "which editions exist".',
    inputSchema: { key: z.string().describe('An album key.') },
    annotations: READ,
  }, ({ key }) => run(() => more.versions(key)));

  server.registerTool('roon_similar', {
    title: 'More like this',
    description: 'More like this, as Roon itself suggests. For an album `key` (`kind: "album"`, the default): `similar` and `recommended`. For an artist `key` (`kind: "artist"`): `recommended` (where to start with this artist), `latest` and `appears_on`. Every album carries a `key`. Use this before your own knowledge for "something like this", "where do I start with …".',
    inputSchema: { key: z.string(), kind: z.enum(['album', 'artist']).optional(), limit: limit(40, 12) },
    annotations: READ,
  }, ({ key, kind, limit: n }) => run(() => (kind === 'artist' ? more.similarArtist(key, n ?? 12) : more.similarAlbum(key, n ?? 12))));

  // ---- signal path and MUSE ----
  server.registerTool('roon_signal_path', {
    title: 'Signal path',
    description: 'Roon\'s signal path — what happens to the sound between the file and the speaker, per zone that plays: the overall `quality` (lossless = bit-perfect to the device; enhanced = changed on purpose, e.g. upsampling or DSP; high / low = lossy somewhere), clipping, processing speed, and the `steps` in order (source with format, sample-rate conversion, DSP, volume, the device, the output). Zones that don\'t play have no path. For "is this bit-perfect?", "what is Roon doing to the sound?".',
    inputSchema: { zone: z.string().optional().describe('A Roon zone name; leave out for all zones.') },
    annotations: READ,
  }, ({ zone: zn }) => run(() => more.signalPath(zn)));

  server.registerTool('roon_dsp', {
    title: 'MUSE (DSP)',
    description: 'MUSE — Roon\'s DSP engine — as set up for a zone: whether DSP is on, the active preset and the saved presets, and each part in order with its state and values (headroom, sample_rate_conversion, crossfeed, parametric_eq, convolution, speaker_setup, headphone_eq …). A part with `on: false` is configured but bypassed. This is the configuration; roon_signal_path shows what happens to the music that plays now.',
    inputSchema: { zone: z.string().optional().describe('A Roon zone name; leave out for all zones.') },
    annotations: READ,
  }, ({ zone: zn }) => run(() => more.dsp(zn)));

  server.registerTool('roon_dsp_set', {
    title: 'Switch MUSE',
    description: 'Switch MUSE (Roon\'s DSP) on a zone: `enabled` turns the whole DSP on or off; `part` + `enabled` turns one part on or off (names from roon_dsp); `preset` loads a saved preset by name. This changes how the zone SOUNDS: only on an explicit request, one change at a time, after reading roon_dsp. It doesn\'t edit EQ bands or other values. Reads it back.',
    inputSchema: { zone, enabled: z.boolean().optional(), part: z.string().optional(), preset: z.string().optional() },
    annotations: CHANGES,
  }, ({ zone: zn, enabled, part, preset }) => run(() => more.dspSet(zn, { enabled, part, preset })));
}
