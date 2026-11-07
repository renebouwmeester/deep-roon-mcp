import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { playlistEdit, playlistEditOn, playlistSnapshot } from '../roon/playlist-edit';
import { run } from './run';
export const PLAYLIST_WRITES = ['roon_playlist_add_tracks', 'roon_playlist_remove_tracks', 'roon_playlist_reorder_tracks', 'roon_playlist_rename'];
export function registerPlaylistEditTools(server: McpServer) {
  server.registerTool('roon_playlist_snapshot', {
    title: 'Complete playlist snapshot',
    description: 'Read a complete playlist by exact key from roon_playlists. Returns a revision and an id for each track occurrence, including duplicates. Use these for edits; display row numbers and track keys do not identify occurrences.',
    inputSchema: { key: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ key }) => run(() => playlistSnapshot(key)));
  if (!playlistEditOn()) return;
  const common = { key: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) };
  const items = z.array(z.string().min(1)).min(1).max(200);
  const before = z.string().min(1).optional().describe('Insert before this occurrence id; omit to place at the end.');
  const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
  const safety = ' Experimental: only on an explicit user request. Requires a fresh roon_playlist_snapshot revision and confirm:true. Native writable Roon playlists only. Verifies the entire saved result. If uncertain, inspect Roon and read a fresh snapshot; never retry automatically.';
  server.registerTool('roon_playlist_add_tracks', {
    title: 'Add playlist tracks', description: 'Add track keys in the given order, retaining duplicates.' + safety,
    inputSchema: { ...common, keys: z.array(z.string().regex(/^-?\d+$/)).min(1).max(200), before }, annotations,
  }, args => run(() => playlistEdit({ ...args, action: 'add' })));
  server.registerTool('roon_playlist_remove_tracks', {
    title: 'Remove playlist occurrences', description: 'Remove only the selected occurrence ids. Other copies of the same track remain.' + safety,
    inputSchema: { ...common, items }, annotations,
  }, args => run(() => playlistEdit({ ...args, action: 'remove' })));
  server.registerTool('roon_playlist_reorder_tracks', {
    title: 'Move playlist occurrences', description: 'Move selected occurrence ids before an anchor or to the end, preserving their original relative order.' + safety,
    inputSchema: { ...common, items, before }, annotations,
  }, args => run(() => playlistEdit({ ...args, action: 'reorder' })));
  server.registerTool('roon_playlist_rename', {
    title: 'Rename a playlist', description: 'Rename without overwriting another playlist with the same name.' + safety,
    inputSchema: { ...common, name: z.string().min(1).max(500) }, annotations,
  }, args => run(() => playlistEdit({ ...args, action: 'rename' })));
}
