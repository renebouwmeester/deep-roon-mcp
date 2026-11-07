// The MCP bundle for Claude Desktop (deep-roon-mcp-<version>.mcpb): the one-file server, the manifest with the user's
// settings, the licences. The tool list in the manifest comes from the server itself (tools/list), so it can't drift.
//   node scripts/bundle.mjs        (after npm run build)
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = path.join(root, 'dist/deep-roon-mcp.js');
if (!fs.existsSync(server)) { console.error('dist/deep-roon-mcp.js is missing — npm run build first'); process.exit(1); }

// The tools, from the server (no Core needed for tools/list).
const client = new Client({ name: 'bundle', version: pkg.version });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, DEEP_ROON_NO_UPDATE_CHECK: '1', ROON_HOST: '127.0.0.1', DEEP_ROON_PLAYLIST_EDIT: '1' }, stderr: 'ignore' }));
const { tools } = await client.listTools();
await client.close();

const manifest = {
  manifest_version: '0.3',
  name: 'deep-roon-mcp',
  display_name: 'Deep Roon MCP',
  version: pkg.version,
  description: 'Talk to your Roon Core: search your library, Qobuz and TIDAL, read the reviews and biographies Roon shows, Focus, Daily Picks, your history — and play on your zones.',
  long_description: [
    '**Unofficial.** Deep Roon MCP is not made, endorsed or supported by Roon Labs.',
    'It reaches your Roon Core two ways: Roon\'s official extension API (zones, playback, volume, grouping), and Roon\'s internal protocol — the one Roon\'s own apps use — through Arthur Soares\' [roon-api-reverse-engineering](https://github.com/arthursoares/roon-api-reverse-engineering). Roon Labs allows that protocol for tinkering with your own system, but it is not hardened for third-party use, any Roon update can change it, and misuse can cause memory or compute leaks in the Core. Read [Arthur\'s thread on the Roon Community](https://community.roonlabs.com/t/reverse-engineering-the-roon-desktop-clients-local-protocol-typescript-client-docs/321731) before you use it.',
    '**Use it entirely at your own risk.** It comes without any warranty (Apache 2.0). If your Core misbehaves, quit Deep Roon MCP and restart the Core. Report problems on GitHub, not to Roon\'s support. Keep port 9332 on your own network — never forward it to the internet. Switch "Use Roon\'s internal protocol" off and only the official API is used.',
    'Runs on your computer and talks only to your own Roon Core on your network. Enable it once in Roon: Settings › Extensions.',
  ].join('\n\n'),
  author: { name: 'René Bouwmeester', url: 'https://github.com/renebouwmeester' },
  homepage: pkg.homepage,
  repository: { type: 'git', url: 'https://github.com/renebouwmeester/deep-roon-mcp' },
  support: 'https://github.com/renebouwmeester/deep-roon-mcp/issues',
  license: 'Apache-2.0',
  keywords: ['roon', 'music', 'qobuz', 'tidal', 'audio'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
      env: {
        ROON_HOST: '${user_config.roon_host}',
        DEEP_ROON_TOOLS: '${user_config.essentials}',
        DEEP_ROON_INTERNAL: '${user_config.internal_protocol}',
        DEEP_ROON_READ_ONLY: '${user_config.read_only}',
        DEEP_ROON_PLAYLIST_EDIT: '${user_config.playlist_editing}',
      },
    },
  },
  user_config: {
    roon_host: {
      type: 'string', title: 'Roon Core address', required: false, default: '',
      description: 'Leave empty: Deep Roon MCP finds the Core on your network. Fill in the Core\'s address when it is on another subnet or reached over a VPN such as Tailscale (a private one only).',
    },
    essentials: {
      type: 'boolean', title: 'Essentials only', required: false, default: false,
      description: 'Seventeen tools instead of all of them — for clients and small models that struggle with many tools.',
    },
    internal_protocol: {
      type: 'boolean', title: 'Use Roon\'s internal protocol', required: false, default: true,
      description: 'Off: only Roon\'s official extension API — zones, playback, volume, grouping. No search, reviews, Focus or history.',
    },
    read_only: {
      type: 'boolean', title: 'Read-only library', required: false, default: false,
      description: 'On: Deep Roon never changes your Roon library — no playlists, hearts, Listen Later, library additions or DSP changes. Playing music still works.',
    },
    playlist_editing: {
      type: 'boolean', title: 'Edit existing playlists (experimental)', required: false, default: false,
      description: 'On: four more tools add, remove, move and rename tracks in your own Roon playlists. Each edit is checked against a fresh read and verified afterwards. Off with a read-only library.',
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: t.title ?? t.description?.split('. ')[0] ?? t.name })),
  tools_generated: false,
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } },
};

const dir = path.join(root, 'build/bundle');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
fs.copyFileSync(server, path.join(dir, 'server/index.js'));
for (const f of ['LICENSE', 'NOTICE', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
fs.copyFileSync(path.join(root, 'dist/THIRD_PARTY_LICENSES.txt'), path.join(dir, 'THIRD_PARTY_LICENSES.txt'));
if (fs.existsSync(path.join(root, 'icon.png'))) { fs.copyFileSync(path.join(root, 'icon.png'), path.join(dir, 'icon.png')); manifest.icon = 'icon.png'; }
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const mcpb = path.join(root, 'node_modules/.bin/mcpb');
execFileSync(mcpb, ['validate', path.join(dir, 'manifest.json')], { stdio: 'inherit' });
const out = path.join(root, 'dist', `deep-roon-mcp-${pkg.version}.mcpb`);
execFileSync(mcpb, ['pack', dir, out], { stdio: 'inherit' });
console.log(`${path.relative(root, out)} — ${tools.length} tools`);
