// Deep Roon MCP — an MCP server for Roon over stdio. It talks to the user's own Roon Core on the local network: the
// extension API (9330) for the Core's identity, and Roon's internal protocol (9332) for everything the official API
// doesn't reach. Nothing leaves the network except what the MCP client sends to its model.
//
//   ROON_HOST=<address>[:port]   the Core, when it can't be found on the network (another subnet, a VPN)
//   ROON_PROFILE=<name>          the Roon profile to use (history, Home, favourites, Listen Later); empty = the first
//   DEEP_ROON_HTTP=[host:]port   serve MCP over HTTP (Streamable HTTP, stateless, POST /mcp) instead of stdio — for a
//                                client that can't start a local process. No authentication: keep it on 127.0.0.1 (the
//                                default host) or behind something that has it.
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerReadTools } from './tools/read';
import { registerControlTools } from './tools/control';
import { registerLibraryTools } from './tools/library';
import { PLAYLIST_WRITES } from './tools/playlist-edit';
import { registerStatusTool } from './tools/status';
import { afterFirstConnect } from './core/session';
import { checkForUpdate, selfTest } from './core/status';
import { runSelfTest } from './roon/selftest';
import { findTarget, shutdown } from './core/session';
import { log } from './core/log';
import { version } from '../package.json';

const INSTRUCTIONS = `Deep Roon MCP connects to the user's own Roon Core (music player software, with Qobuz and/or TIDAL behind it when the user has them).
- Albums, tracks and artists come with a \`key\`; keys stay valid between calls — no need to search again.
- Reviews and biographies are Roon's own texts: when asked for them, show them in full with the author's name.
- What plays changes all the time: read roon_now_playing afresh before describing it.
- "Daily Mixes" are Roon's own (roon_mixes); the user's TIDAL mixes (My Mix 1 …, My Daily Discovery) are roon_tidal_playlists with shelf my_mixes, and their tracks can be read with roon_playlist.
- Unofficial: this uses Roon's internal protocol, which a Roon update can change; if a tool says so, tell the user to check for an update.`;

/** The server with its tools, as the switches say. */
/** The tools that write into the Core's library or settings through the internal protocol (0.5.0): left out with
 *  DEEP_ROON_READ_ONLY. Playback (a queue, a volume, a zone's state) passes; the library, playlists and DSP don't change. */
const LIBRARY_WRITES = new Set([...PLAYLIST_WRITES, 'roon_playlist_create', 'roon_favorite', 'roon_radio_favorite', 'roon_listen_later_set', 'roon_library_add', 'roon_dsp_set']);
/** With DEEP_ROON_READ_ONLY=all also everything that plays, queues or switches a zone: Deep Roon only looks. */
const PLAYBACK = new Set(['roon_device_reset', 'roon_play', 'roon_play_tracks', 'roon_play_radio', 'roon_play_mix', 'roon_play_playlist', 'roon_control', 'roon_seek', 'roon_volume',
  'roon_settings', 'roon_queue_jump', 'roon_queue_remove', 'roon_queue_move', 'roon_queue_clear', 'roon_transfer', 'roon_group', 'roon_ungroup', 'roon_sleep', 'roon_standby']);
export type ReadOnly = 'off' | 'library' | 'all';

function buildServer(internal: boolean, essentials: boolean, readOnly: ReadOnly = 'off'): McpServer {
  const instructions = readOnly === 'off' ? INSTRUCTIONS : INSTRUCTIONS + (readOnly === 'all'
    ? '\n- Read-only (set by the user): Deep Roon only looks — it can\'t play, queue, change a zone, or change the library. Say so when asked.'
    : '\n- Read-only library (set by the user): Deep Roon can play and control zones, but it can\'t change the library, playlists, hearts, Listen Later or DSP. Say so when asked.');
  const server = new McpServer({ name: 'deep-roon-mcp', title: 'Deep Roon MCP', version, websiteUrl: 'https://github.com/renebouwmeester/deep-roon-mcp' }, { instructions });
  const essentialSet = new Set(['roon_status', 'roon_search', 'roon_album', 'roon_review', 'roon_bio', 'roon_artist', 'roon_zones', 'roon_now_playing', 'roon_play',
    'roon_play_tracks', 'roon_control', 'roon_volume', 'roon_queue', 'roon_playlists', 'roon_play_playlist', 'roon_daily_picks', 'roon_top']);
  const keep = (name: string) => (!essentials || essentialSet.has(name)) && !(readOnly !== 'off' && LIBRARY_WRITES.has(name)) && !(readOnly === 'all' && PLAYBACK.has(name));
  if (essentials || readOnly !== 'off') {
    const original = server.registerTool.bind(server) as Function;
    (server as { registerTool: Function }).registerTool = (name: string, cfg: unknown, cb: unknown) => (keep(name) ? original(name, cfg, cb) : undefined);
  }
  registerStatusTool(server, internal);
  registerReadTools(server, internal);
  registerControlTools(server, internal);
  if (internal) registerLibraryTools(server);
  return server;
}

/** MCP over HTTP: each POST to /mcp gets a fresh server and transport (stateless) — the Core connection, the keys and the
 *  pairing live in the process and are shared. */
function serveHttp(spec: string, internal: boolean, essentials: boolean, readOnly: ReadOnly): void {
  const m = /^(?:(.+):)?(\d+)$/.exec(spec.trim());
  if (!m) { log(`DEEP_ROON_HTTP should be [host:]port, not "${spec}"`); process.exit(1); }
  const host = m[1] || '127.0.0.1', port = Number(m[2]);
  const web = http.createServer(async (req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('Parse error'); return; }
    const server = buildServer(internal, essentials, readOnly);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch (e) { log(`http: ${(e as Error).message}`); if (!res.headersSent) res.writeHead(500).end(); }
  });
  web.listen(port, host, () => log(`${version} ready (http://${host}:${port}/mcp)`));
}

async function main(): Promise<void> {
  // The switches (the bundle's settings, or the environment):
  //   DEEP_ROON_INTERNAL=off   only the official extension API — Roon's internal protocol stays closed
  //   DEEP_ROON_TOOLS=essentials   seventeen tools instead of all, for clients and small models that choke on many
  const internal = !/^(off|false|0|no)$/i.test(process.env.DEEP_ROON_INTERNAL ?? '');
  const essentials = /^(essentials|true|1|yes)$/i.test(process.env.DEEP_ROON_TOOLS ?? process.env.DEEP_ROON_ESSENTIALS ?? '');
  //   DEEP_ROON_READ_ONLY=library   (or 1/true/yes) nothing changes the library, playlists, hearts or DSP; =all: also no playback
  const ro = (process.env.DEEP_ROON_READ_ONLY ?? '').trim().toLowerCase();
  const readOnly: ReadOnly = ro === 'all' ? 'all' : /^(library|true|1|yes)$/.test(ro) ? 'library' : 'off';
  if (internal) afterFirstConnect(() => selfTest(runSelfTest));
  checkForUpdate().catch(() => {});
  log(`${internal ? 'internal protocol on' : 'internal protocol OFF — official API only'}${essentials ? ', essentials' : ''}${readOnly === 'off' ? '' : readOnly === 'all' ? ', READ-ONLY (looks only)' : ', read-only library'}`);
  const httpSpec = process.env.DEEP_ROON_HTTP;
  if (httpSpec) serveHttp(httpSpec, internal, essentials, readOnly);
  else {
    await buildServer(internal, essentials, readOnly).connect(new StdioServerTransport());
    log(`${version} ready (stdio)`);
    process.stdin.on('close', () => { shutdown(); process.exit(0); });
  }
  // Find the Core and connect the extension right away, so Deep Roon MCP shows up in Roon's Settings → Extensions.
  findTarget().catch((e) => log(`no Roon Core yet: ${(e as Error).message}`));
  const stop = () => { shutdown(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { log(`fatal: ${(e as Error).message}`); process.exit(1); });
