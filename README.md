# Deep Roon MCP

The parts of Roon the official API doesn't reach, for Claude and any other MCP client: the reviews and biographies Roon
shows, search across your library and Qobuz or TIDAL at once, their editorial shelves, TIDAL's playlists and mixes, Live Radio,
album pages with credits, artist discographies, and your own play history with real "most played" counts.

> **Read this first.** Deep Roon MCP is unofficial: it is not made, endorsed or supported by Roon Labs. It uses Roon's
> internal protocol — the one Roon's own apps use — through Arthur Soares'
> [roon-api-reverse-engineering](https://github.com/arthursoares/roon-api-reverse-engineering), which Roon Labs allows
> for tinkering with your own system. Brian Luczkiewicz (Roon Labs) on that protocol: it is *"not hardened for 3rd party
> use"*, it can change with any Roon update, and misuse can cause memory or compute leaks in the Core. Read
> [Arthur's thread on the Roon Community](https://community.roonlabs.com/t/reverse-engineering-the-roon-desktop-clients-local-protocol-typescript-client-docs/321731)
> before you use it.
>
> **Use it entirely at your own risk.** It comes without any warranty (see the licence). If your Core misbehaves, quit
> Deep Roon MCP and restart the Core. Report problems here, not to Roon's support. Keep port 9332 on your own network,
> never forward it to the internet. A Roon update can break a tool until Deep Roon MCP is updated. With the internal
> protocol switched off (see the settings below) only Roon's official extension API is used.

**What stays at home.** Deep Roon MCP runs on your computer and talks to your Roon Core over your own network. It has no
server of its own and sends nothing anywhere else. What you ask goes to your MCP client's model like any other question.

## Status

Version 0.5: sixty-four tools (fifty-eight with a read-only library; sixty-eight with playlist editing on). Qobuz, TIDAL or both — whatever is signed in on your Core.

**Reading** — changes nothing in Roon:

| Tool | What it does |
|---|---|
| `roon_search` | Your library, Qobuz and TIDAL at once: albums (with format), artists, tracks — each says where it's from |
| `roon_new` | Qobuz's shelves (new, qobuzissimes, press awards, top, trending, ideal discography) or TIDAL's (new, recommended, top, rising, masters; albums or tracks) — by genre |
| `roon_genres` | Qobuz's genres and their ids, or TIDAL's genres and moods |
| `roon_album` | An album's page: tracks, release dates, label, barcode, credits |
| `roon_track_files` | Where your own files are: per track of an album, an artist or a list of tracks, the file path as the Core sees it (and duplicates) — Roon's export data |
| `roon_review` | The review Roon shows, in full, with its author |
| `roon_bio` | The biography Roon shows, in full, with related artists |
| `roon_artist` | An artist's discography at Qobuz or TIDAL, oldest first |
| `roon_status` | How Deep Roon MCP stands: Core, pairing, internal protocol, self-test, newer version |
| `roon_zones` | Roon's zones and groups |
| `roon_now_playing` | What plays in each zone, with the volume |
| `roon_waveform` | The waveform of what plays in a zone, as Roon draws it in its seek bar (local files, and streams once played) |
| `roon_queue` | A zone's queue, numbered (1 is what plays) |
| `roon_cover` | The cover of what plays, as an image |
| `roon_history` | Roon's play history, newest first |
| `roon_top` | Most played albums, artists or tracks over your whole history |
| `roon_profiles` | The Roon profiles, and the one Deep Roon uses |
| `roon_library` | Your library with Roon's Focus: stars, genre, label, artist, composer, producer, years, hi-res, live … sorted any way |
| `roon_focus` | The Focus panel: what your library (or part of it) is made of, with counts |
| `roon_tracks`, `roon_artists` | Focus on tracks and artists (and composers) |
| `roon_works`, `roon_work` | Compositions, and one work with its description and your recordings of it |
| `roon_daily_picks` | Today's Daily Picks from Roon's Home, with why |
| `roon_new_for_you` | New releases Roon picked for you |
| `roon_mixes` | Today's Daily Mixes |
| `roon_playlists`, `roon_playlist` | Your playlists, and one playlist's tracks |
| `roon_playlist_snapshot` | One of your playlists complete, with an id for every track in it (also a track that's in it twice) — what the playlist edits below work from |
| `roon_tidal_playlists` | TIDAL's playlists: its editorial shelves, by genre or mood, and your own TIDAL mixes |
| `roon_favorites` | Albums with a heart in Roon, or your Qobuz or TIDAL favourites |
| `roon_listen_later` | Your Listen Later list |
| `roon_versions` | Other versions of an album: remasters, hi-res, in your library and streaming |
| `roon_similar` | More like this, for an album or an artist |
| `roon_signal_path` | Roon's signal path for what plays: is it bit-perfect, what happens on the way |
| `roon_dsp` | MUSE: the DSP set up for a zone |
| `roon_devices` | The RAAT audio devices of Settings › Audio: enabled, and whether they have a zone |
| `roon_radio` | Live Radio: your own stations, the directory by category and genre |

**Playing** — only on your request:

| Tool | What it does |
|---|---|
| `roon_play` | An album on a zone: now, next or at the end of the queue, optionally shuffled |
| `roon_play_tracks` | Your own running order of tracks |
| `roon_control` | Pause, play, stop, next, previous |
| `roon_seek` | A position in the playing track |
| `roon_volume` | A zone's volume, mute |
| `roon_settings` | Shuffle, repeat, Roon Radio |
| `roon_queue_jump`, `roon_queue_remove`, `roon_queue_move` | Jump to an item of the queue, take items out, move one before or after another |
| `roon_queue_clear` | Clear what comes after the playing track (or everything) |
| `roon_transfer` | Move what plays, with its queue, to another zone |
| `roon_group`, `roon_ungroup` | Group zones, and undo it |
| `roon_sleep` | A sleep timer |
| `roon_standby` | Put a device in standby, or wake it |
| `roon_device_reset` | Disable and enable a device stuck on "Enabling…" (enabled, no zone) — only those |
| `roon_play_playlist` | A playlist on a zone (also a TIDAL one), optionally shuffled |
| `roon_play_mix` | One of today's Daily Mixes |
| `roon_play_radio` | A Live Radio station on a zone |

**Changing your library or sound** — only on your request; each one reads the result back and says if Roon didn't follow.

> **A word of care.** These six tools write into your Core's library and settings through Roon's *internal* protocol —
> the same wiring Roon's own apps use, but not an API Roon Labs supports for others. Deep Roon is careful with it (one
> change at a time, read back, nothing in bulk), but a Roon update can change that wiring under it. **Keep a recent backup
> of your Roon database** (Roon › Settings › Backups) before you let an assistant change things — and if you only want to
> ask and listen, switch on **Read-only library** below: then these six tools aren't there at all.


| Tool | What it does |
|---|---|
| `roon_favorite` | A heart on an album or track, or off |
| `roon_listen_later_set` | On or off the Listen Later list |
| `roon_library_add` | A Qobuz or TIDAL album into your library |
| `roon_playlist_create` | A new playlist from tracks |
| `roon_dsp_set` | MUSE on or off, one part on or off, or a preset |
| `roon_radio_favorite` | A station into My Live Radio, or out of it |

**Editing your own playlists** — experimental, and off until you switch on **Edit existing playlists** below
(`DEEP_ROON_PLAYLIST_EDIT=1`). Only your own Roon playlists; imported, smart, Qobuz and TIDAL playlists are refused. Each
edit starts from a fresh `roon_playlist_snapshot`, is checked once more right before it's written, and is read back in
full afterwards; if that read doesn't match, it says so and doesn't try again. With **Read-only library** on they aren't
there. Contributed by kvarnelis on GitHub.

| Tool | What it does |
|---|---|
| `roon_playlist_add_tracks` | Tracks into a playlist, at the end or before a given track |
| `roon_playlist_remove_tracks` | Tracks out of a playlist — only the ones you point at, not other copies of the same track |
| `roon_playlist_reorder_tracks` | Tracks to another place in a playlist |
| `roon_playlist_rename` | A playlist under a new name (never onto a name another playlist already has) |

## Install

Deep Roon MCP runs on a computer on the same network as your Roon Core (Mac, Windows or Linux), next to your MCP client.

### Claude Desktop — one click

1. Download **`deep-roon-mcp-<version>.mcpb`** from the [latest release](https://github.com/renebouwmeester/deep-roon-mcp/releases/latest).
2. Open it (double-click, or drag it onto Claude Desktop's Settings › Extensions). Claude Desktop shows the tools and the
   settings; click Install. It runs on Claude Desktop's own Node — nothing else to install.
3. **In Roon:** Settings › Extensions › **Enable** next to "Deep Roon MCP". Once.
4. Ask something: "What's new on Qobuz in jazz?", "Show me Roon's review of Kind of Blue", "Play Spirit of Eden in the
   living room".

The settings (Claude Desktop › Settings › Extensions › Deep Roon MCP):

| Setting | What it does |
|---|---|
| Roon Core address | Empty: found on your network. Fill in the Core's address for another subnet or a private VPN (Tailscale) |
| Essentials only | Seventeen tools instead of sixty-one, for small models |
| Use Roon's internal protocol | Off: only the official API — zones, playback, volume, grouping; no search, reviews, Focus or history |
| Read-only library | On: Deep Roon never changes your library — no playlists, hearts, Listen Later, library additions or DSP. Playing still works |
| Edit existing playlists | Experimental, off by default. On: the four playlist edits above |

### Other clients

Needs [Node.js](https://nodejs.org) 18 or newer. The package runs straight from npm with `npx`:

**Claude Code**

```sh
claude mcp add deep-roon -- npx -y deep-roon-mcp
```

**ChatGPT desktop app and Codex** — they share one configuration. In the ChatGPT desktop app: Settings › MCP servers ›
Add server, name `deep-roon`, type STDIO, command `npx`, arguments `-y deep-roon-mcp`; save, then Restart. Or from a
terminal:

```sh
codex mcp add deep-roon -- npx -y deep-roon-mcp
```

or by hand in `~/.codex/config.toml`:

```toml
[mcp_servers.deep-roon]
command = "npx"
args = ["-y", "deep-roon-mcp"]
# env = { ROON_HOST = "", ROON_PROFILE = "", DEEP_ROON_TOOLS = "", DEEP_ROON_INTERNAL = "", DEEP_ROON_READ_ONLY = "" }
```

ChatGPT on the web can't run a server on your computer — use the desktop app.

**Cursor, VS Code, Windsurf, Cline, LM Studio, Claude Desktop by hand …** — in the client's MCP configuration:

```json
{
  "mcpServers": {
    "deep-roon": {
      "command": "npx",
      "args": ["-y", "deep-roon-mcp"],
      "env": { "ROON_HOST": "", "ROON_PROFILE": "", "DEEP_ROON_TOOLS": "", "DEEP_ROON_INTERNAL": "", "DEEP_ROON_READ_ONLY": "" }
    }
  }
}
```

The same settings as environment variables: `ROON_HOST` (the Core's address, empty = find it), `ROON_PROFILE` (a Roon profile
by name, empty = the first; see below), `DEEP_ROON_TOOLS=essentials`,
`DEEP_ROON_INTERNAL=off`, `DEEP_ROON_READ_ONLY=library` (nothing changes the library; playing works) or `DEEP_ROON_READ_ONLY=all`
(Deep Roon only looks: no playing, queueing or zone changes either), `DEEP_ROON_PLAYLIST_EDIT=1` (the playlist edits). Leave out what you don't need. VS Code calls the block `"servers"` instead of `"mcpServers"`.

Then, once, in Roon: Settings › Extensions › **Enable** next to "Deep Roon MCP". Until then the tools say so.

**Roon profiles.** The play history, most played, Daily Picks, Daily Mixes, New for you, favourites and Listen Later belong to
a Roon profile. Deep Roon is a Roon remote of its own, like each Roon app, so switching profiles in a Roon app doesn't change
it: it uses `ROON_PROFILE` (or **Roon profile** in Claude Desktop's settings), else the first profile. Those tools also take
`profile` for one question ("what did Anna play this week?"); `roon_profiles` lists the names.

### Over HTTP

For a client that can't start a program on your computer, Deep Roon MCP can serve MCP over HTTP instead (Streamable
HTTP, stateless, `POST /mcp`):

```sh
DEEP_ROON_HTTP=127.0.0.1:9301 npx -y deep-roon-mcp
```

`DEEP_ROON_HTTP` is `[host:]port`; the host defaults to `127.0.0.1`. There is **no authentication**: keep it on your own
computer, or put it behind something that has one (a reverse proxy with a key, a private tunnel). Never expose it to
the internet as it is.

### From source

```sh
git clone https://github.com/renebouwmeester/deep-roon-mcp
cd deep-roon-mcp && npm install && npm run build
# then use: node /path/to/deep-roon-mcp/dist/deep-roon-mcp.js
```

## When something's wrong

**"No Roon Core found" on a Mac:** macOS asks once whether the app may use the local network — for Claude Desktop that's
Claude and Claude Helper, for the ChatGPT desktop app ChatGPT. Allow it (System Settings › Privacy & Security › Local
Network), then try again.

Ask your client to run **`roon_status`**: the Core it found, whether it's enabled in Roon, whether the internal protocol
works, and a self-test of a few reads with the tools each stands for. After a Roon update a tool may break until Deep Roon
MCP is updated — the first answer says so when a newer version is out. Issues:
[github.com/renebouwmeester/deep-roon-mcp/issues](https://github.com/renebouwmeester/deep-roon-mcp/issues) (paste the
status; it holds no secrets).

## How it behaves

- Short connections, as Roon Labs asked: opened for a question, closed after two minutes of quiet, one at a time, questions
  one after another; a PING every 10 s while open, so the Core doesn't drop the session.
- Several clients at once (Claude Desktop and Claude Code, or ChatGPT next to them) work: Roon keeps one connection
  per extension, and the client that asks a question takes it over for that moment.
- Album, track and artist keys stay valid between calls.
- Track artists: a track's `artist` is its album's artist (on a compilation that is often "Various Artists"). Where the
  track's own main artist differs, it comes as `track_artist` — in search, `roon_tracks`, albums, playlists, the queue
  and what plays now. Roon keeps it in the track's credits.
- Covers: every `image` key comes with an `image_url` to load it from your Core. Roon has two kinds of image keys that
  aren't interchangeable. Deep Roon reads Roon's internal library, so most keys are internal ones (short, like
  `doicaaaa`): the Core serves them at `http://<core>:9330/image/<key>.jpg`, or scaled at `/image/<key>.300.jpg` (any
  width). The zones (`roon_now_playing`) come from Roon's official extension API, whose keys (long hex) are served at
  `/api/image/<key>?scale=fit&width=600&height=600`. The URL uses the Core's address as Deep Roon sees it — when Deep
  Roon runs on the Core's own machine that is `127.0.0.1`; from another device, put the Core's IP there.
- The log goes to stderr (your MCP client keeps it).
- At the start it asks GitHub once whether a newer release is out (`DEEP_ROON_NO_UPDATE_CHECK=1` turns that off). Nothing
  else leaves your network except what your client sends to its model.
- The pairing with Roon is kept in your configuration folder (Mac `~/Library/Application Support/deep-roon-mcp`, Windows
  `%APPDATA%\deep-roon-mcp`, Linux `~/.config/deep-roon-mcp`).

## Credits

Arthur Soares for the protocol work (MIT, in `src/intern`). Roon Labs for allowing it.

## License

Apache 2.0 — see `LICENSE` and `NOTICE`. Roon is a trademark of Roon Labs LLC; Qobuz of Xandrie SA; TIDAL of TIDAL Music AS.
