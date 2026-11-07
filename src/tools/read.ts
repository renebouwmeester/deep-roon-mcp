// The read-only tools: search, the streaming shelves and genres (Qobuz, TIDAL), album pages, reviews, biographies, discographies, zones,
// what plays, and the play history. Nothing here changes anything in Roon.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as lib from '../roon/library';
import * as hist from '../roon/history';
import * as zn from '../roon/zones';
import * as rd from '../roon/radio';
import * as off from '../core/officialtools';
import { run } from './run';
import { asProfile, profileInUse, profilesOf, withCore } from '../core/session';

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const service = z.enum(['qobuz', 'tidal']).optional().describe('qobuz or tidal — default: Qobuz when it is signed in in Roon, else TIDAL.');
const profile = z.string().optional().describe('A Roon profile by name (roon_profiles lists them) — default: ROON_PROFILE, else the first profile.');
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).optional().describe(`How many (default ${dflt}, at most ${max}).`);

export function registerReadTools(server: McpServer, internal = true): void {
  const R = (name: string) => internal || name === 'roon_zones' || name === 'roon_now_playing';
  const reg = ((name: string, cfg: unknown, cb: unknown) => (R(name) ? (server.registerTool as Function).call(server, name, cfg, cb) : undefined)) as typeof server.registerTool;
  reg('roon_search', {
    title: 'Search Roon',
    description: 'Search Roon — the user\'s Roon library and the catalogues of the streaming services signed in (Qobuz, TIDAL) at once; each row says its `source` (library, Qobuz, TIDAL). Rows carry `image`, the key of the cover, and `image_url`, where the Core serves it (for clients that draw; a chat shows covers with roon_cover). Deep Roon\'s keys are Roon\'s internal ones (/image/<key>.jpg, scaled /image/<key>.300.jpg), not the official API\'s (roon_now_playing; /api/image/<key>) — `image_url` always has the right one. Returns albums (with format, e.g. FLAC 96kHz 24bit), artists and tracks. `kind` narrows to album, track or artist — use `kind: "track"` with the song title (and artist) to find one specific track; a broad query without `kind` can fill up with artists. Albums and tracks carry a `key` for `roon_album`; artists carry a `key` for `roon_artist` and `roon_bio`. Albums say their `year`, and `in_library` when the user has them in Roon. Keys stay valid between calls.',
    inputSchema: { query: z.string().min(1), kind: z.enum(['album', 'track', 'artist']).optional(), limit: limit(100, 30) },
    annotations: READ,
  }, ({ query, kind, limit: n }) => run(() => lib.search(query, n ?? 30, kind)));

  reg('roon_new', {
    title: 'Streaming shelves in Roon',
    description: 'The editorial shelves of Qobuz or TIDAL as Roon shows them (the same for everyone). Qobuz (`service: "qobuz"`): `new`, `qobuzissimes`, `press_awards`, `top`, `trending`, `ideal_discography` — albums; `genre` narrows a shelf to one or more Qobuz genre ids from `roon_genres`. TIDAL (`service: "tidal"`): `new`, `recommended`, `top`, `rising`, `masters` — albums, or tracks with `what: "tracks"` (not masters); `genre` (one TIDAL genre from `roon_genres`, e.g. "Jazz") gives TIDAL\'s page for that genre instead of a shelf. Use `genre` for "new jazz", "what\'s new in classical"; TIDAL\'s playlists are in roon_tidal_playlists. Albums carry their format and a `key` for `roon_album`; tracks a `key` for roon_play_tracks. `offset` pages through the shelf; `total` says how many there are.',
    inputSchema: {
      service,
      section: z.string().optional().describe('The shelf (default new) — see the list for each service.'),
      genre: z.string().optional().describe('Qobuz: genre id(s) from roon_genres, comma-separated. TIDAL: one genre from roon_genres.'),
      what: z.enum(['albums', 'tracks']).optional().describe('TIDAL only: albums (default) or tracks.'),
      limit: limit(100, 30), offset: z.number().int().min(0).optional(),
    },
    annotations: READ,
  }, ({ service: sv, section, genre, what, limit: n, offset }) => run(() => lib.section(section ?? 'new', n ?? 30, offset ?? 0, (genre ?? '').split(',').map((x) => x.trim()).filter(Boolean), sv, what ?? 'albums')));

  reg('roon_genres', {
    title: 'Streaming genres',
    description: 'The genres of Qobuz or TIDAL, for the `genre` filter of `roon_new` (and, for TIDAL, of `roon_tidal_playlists`). Qobuz: the main genres with their ids (names in the account\'s language); with `parent` (a genre id) its sub-genres, e.g. the kinds of jazz. TIDAL: its genres and its moods (Relax, Focus …), each with an `id` to pass on.',
    inputSchema: { service, parent: z.string().optional().describe('Qobuz: a genre id, to list its sub-genres.') },
    annotations: READ,
  }, ({ service: sv, parent }) => run(() => lib.genres(parent, sv)));

  reg('roon_album', {
    title: 'Album page',
    description: 'One album in Roon, by its `key` (from roon_search, roon_new, roon_artist): the album with year, format, label and whether it is in the library, its genres, release date (and the date of this edition), barcode and — when Roon has them — catalogue number and country, its main artist(s) with a `key` for `roon_artist` / `roon_bio`, and every track with its own `key`. A streaming album that is also in the library comes back as the library copy (its key may differ; both work). `credits: true` adds who played, produced, engineered and wrote, grouped by role — Roon\'s own data.',
    inputSchema: { key: z.string().describe('An album key.'), credits: z.boolean().optional() },
    annotations: READ,
  }, ({ key, credits }) => run(() => lib.album(key, credits === true)));

  reg('roon_track_files', {
    title: 'File paths',
    description: 'Where the user\'s own music files are: for an album (`album` key), an artist (`artist` key, all their tracks in the library) or a list of `tracks` keys, each track with its `key`, title, album, track number, format and `path` — the file as the Roon Core sees it (on the Core\'s storage), plus `duplicates` when Roon has the same track twice. The data behind Roon\'s own Export. Use it to link Roon\'s tracks to files, e.g. to join with data the user keeps per file. Streaming tracks (Qobuz, TIDAL) have no path.',
    inputSchema: {
      album: z.string().optional().describe('An album key.'),
      artist: z.string().optional().describe('An artist key.'),
      tracks: z.array(z.string()).max(500).optional().describe('Track keys.'),
    },
    annotations: READ,
  }, ({ album, artist, tracks }) => run(() => lib.trackFiles({ album, artist, tracks })));

  reg('roon_review', {
    title: 'Album review',
    description: 'The review Roon shows on an album\'s page, in full, with its author — by album `key`. When the user asks for the review ("what does Roon say about this album", "show me the review"), they want to read the review itself: show the text complete and exactly as returned, as a quote with the author\'s name — no paraphrase or shortening unless they ask for a summary, and don\'t go to the web for it. `wikipedia: true` adds the album\'s Wikipedia text; it also comes by itself when Roon has no review of its own. `max_chars` only when a shorter excerpt is asked for.',
    inputSchema: { key: z.string().describe('An album key.'), wikipedia: z.boolean().optional(), max_chars: z.number().int().min(200).optional() },
    annotations: READ,
  }, ({ key, wikipedia, max_chars }) => run(() => lib.review(key, max_chars ?? 1e9, wikipedia === true)));

  reg('roon_bio', {
    title: 'Artist biography',
    description: 'The biography Roon shows on an artist\'s page, in full, with its author — by artist `key` — plus where they are from, active since, genres, and the related artists Roon lists: `similar`, `influenced_by`, `influenced`, `worked_with`, `member_of`, `members`, each with a `key` for `roon_artist` / `roon_bio`. When the user asks for the bio ("who is …", "tell me about this artist"), show the text complete and exactly as returned, with the author\'s name — no paraphrase or shortening unless they ask for a summary. For a narrower question ("who influenced them") answer from the lists. `wikipedia: true` adds the Wikipedia text; `max_chars` only when a shorter excerpt is asked for.',
    inputSchema: { key: z.string().describe('An artist key.'), wikipedia: z.boolean().optional(), max_chars: z.number().int().min(200).optional() },
    annotations: READ,
  }, ({ key, wikipedia, max_chars }) => run(() => lib.bio(key, max_chars ?? 1e9, wikipedia === true)));

  reg('roon_artist', {
    title: 'Discography',
    description: 'An artist\'s discography in Roon: the main albums Qobuz (or, with `service: "tidal"`, TIDAL) has, oldest first, each with year, format and a `key` for `roon_album`. The artist `key` comes from roon_search (`kind: "artist"`) or from the `artists` of roon_album. Use this for "the album before/after …", "their debut", "what else did they make" — don\'t answer discography questions from memory. The year is the original release where Roon knows it; reissues and compilations are in the list too.',
    inputSchema: { key: z.string().describe('An artist key.'), service },
    annotations: READ,
  }, ({ key, service: sv }) => run(() => lib.discography(key, sv)));

  reg('roon_zones', {
    title: 'Roon zones',
    description: 'The zones Roon can play on (Roon\'s own names), and which are grouped right now (`groups`).',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => (internal ? zn.zones() : off.zones())));

  reg('roon_waveform', {
    title: 'Waveform',
    description: 'The waveform of the track that plays in a zone, as Roon draws it in its seek bar: `waveform` is a list of heights from 0 to 1 (`points` of them, default 100), left to right over the track, with the `position` and `length`. Draw it as Roon does: each height a thin bar mirrored around a centre line (as far above as below), the part before `position` in a colour and the rest grey. Roon makes one for a local file when it has analysed it, and for a stream (Qobuz, TIDAL) the first time it plays; until then `waveform` is null. Only for what plays now, not for any track.',
    inputSchema: {
      zone: z.string().min(1).describe('The zone, by (part of) its name.'),
      points: z.number().int().min(10).max(2000).optional().describe('How many heights (default 100).'),
      raw: z.boolean().optional().describe('The values as the Core sends them, for debugging.'),
    },
    annotations: READ,
  }, ({ zone, points, raw }) => run(() => zn.waveform(zone, points ?? 100, raw === true)));

  reg('roon_now_playing', {
    title: 'Now playing in Roon',
    description: 'What plays in Roon, per zone: state (playing, loading, paused, stopped), the track with album, artist and format, the position, how many tracks are left in the queue, shuffle, repeat, Roon Radio and a sleep timer. Read this before saying anything about what Roon plays — it changes all the time.',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => (internal ? zn.nowPlaying() : off.nowPlaying())));

  reg('roon_radio', {
    title: 'Live Radio',
    description: 'Roon\'s Live Radio directory. Without arguments: the user\'s own stations (`my_stations`) and the top categories (Music, News & Talk, Sports, Locations), each with a `key`. With `category` (a key): its sub-categories and stations. With `genre` (a category\'s name as written, e.g. "Jazz", "Classical"): stations of that genre. Stations carry a `key` for roon_play_radio, their location, and their logo: `image_url` (a plain https picture) for the directory, `image` (a key at the Core) for an own station.',
    inputSchema: { category: z.string().optional().describe('A category key from a previous answer.'), genre: z.string().optional().describe('A genre, as roon_radio names it (e.g. Jazz).'), limit: limit(100, 40) },
    annotations: READ,
  }, ({ category, genre, limit: n }) => run(() => rd.radio(category, genre, n ?? 40)));

  reg('roon_history', {
    title: 'Play history',
    description: 'What was played in Roon, newest first — Roon\'s own play history, with how much of each track was heard. Goes back as far as Roon\'s history does — Roon filters by date itself: `since` and `before` (YYYY-MM-DD) give the plays in that window (e.g. "what did I play in March 2019": since 2019-03-01, before 2019-04-01; up to 500 per call, `offset` for the next ones). For "most played" questions use roon_top instead of counting this.',
    inputSchema: { limit: limit(500, 30), offset: z.number().int().min(0).optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only plays from this date on (YYYY-MM-DD).'),
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only plays before this date (YYYY-MM-DD).'), profile },
    annotations: READ,
  }, ({ limit: n, offset, since, before, profile: p }) => run(() => asProfile(p, () => hist.history(n ?? 30, offset ?? 0, before, since))));

  reg('roon_top', {
    title: 'Most played',
    description: 'The most played albums, artists or tracks in Roon, counted over the WHOLE play history (a play counts when at least half the track was heard). Use this for "most listened" questions — don\'t tally roon_history yourself. `since` and `until` (YYYY-MM-DD) limit the period — Roon filters by date itself, however far back: "what did I play most in March 2019" is since 2019-03-01, until 2019-04-01.',
    inputSchema: { what: z.enum(['albums', 'artists', 'tracks']).optional(), limit: limit(100, 20), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only plays from this date on (YYYY-MM-DD).'),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only plays before this date (YYYY-MM-DD).'), profile },
    annotations: READ,
  }, ({ what, limit: n, since, until, profile: p }) => run(() => asProfile(p, () => hist.top(what ?? 'albums', n ?? 20, since, until))));

  // The profiles (7 Nov 2026, forum): history, top, Home, favourites and Listen Later are per profile.
  reg('roon_profiles', {
    title: 'Roon profiles',
    description: 'The profiles on this Roon Core, and the one Deep Roon uses (`in_use`). Deep Roon is a Roon remote of its own: switching profiles in a Roon app doesn\'t change it. The play history, most played, Daily Picks, Daily Mixes, New for you, favourites and Listen Later are per profile — those tools take `profile` (a name from here) for one question; ROON_PROFILE sets the default.',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => withCore(async (c) => ({ profiles: profilesOf(c).map((p) => p.name), in_use: profileInUse(c), default: process.env.ROON_PROFILE?.trim() || null }))));
}
