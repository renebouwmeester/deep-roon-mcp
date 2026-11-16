// The tools that change what plays: play, the buttons, seek, volume, shuffle / repeat / Roon Radio, the queue, grouping,
// transfer, sleep timer, standby — and the cover. Each says it acts only on an explicit request.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ctl from '../roon/control';
import * as rd from '../roon/radio';
import { setVolume } from '../core/official';
import * as off from '../core/officialtools';
import { findTarget } from '../core/session';
import { run, runImage } from './run';

// Changes what plays, but isn't destructive: no confirmation needed beyond the user's own request.
const CHANGES_QUEUE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const PLAYS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
// Removes something (the queue) — clients may ask for confirmation.
const REMOVES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const zone = z.string().describe('A Roon zone name (see roon_zones).');
const mode = z.enum(['now', 'next', 'queue']).optional().describe('now (default): plays at once and replaces what plays; next: after the current track; queue: at the end of the queue.');

export function registerControlTools(server: McpServer, internal = true): void {
  // Without the internal protocol only what the official API can do (see core/officialtools.ts).
  const OFFICIAL = new Set(['roon_control', 'roon_seek', 'roon_volume', 'roon_settings', 'roon_transfer', 'roon_group', 'roon_ungroup', 'roon_standby', 'roon_cover']);
  const reg = ((name: string, cfg: unknown, cb: unknown) => (internal || OFFICIAL.has(name) ? (server.registerTool as Function).call(server, name, cfg, cb) : undefined)) as typeof server.registerTool;
  reg('roon_play', {
    title: 'Play an album',
    description: 'Play an album on a Roon zone — the album `key` comes from roon_search, roon_new, roon_artist or roon_album. `mode`: `now` (default), `next` or `queue` (for "queue …" / "add … to the queue"). `shuffle: true` starts it shuffled (Roon\'s own Shuffle button) — one call, no roon_settings needed. Says whether the zone really started (`started`). Only on an explicit request, never as a probe.',
    inputSchema: { key: z.string().describe('An album key.'), zone, mode, shuffle: z.boolean().optional() },
    annotations: PLAYS,
  }, ({ key, zone: zn, mode: m, shuffle }) => run(() => ctl.play(key, zn, m ?? 'now', shuffle === true)));

  reg('roon_play_tracks', {
    title: 'Play tracks',
    description: 'Play a running order of tracks on a Roon zone: track `keys` from roon_search (`kind: "track"`) or roon_album, in the order given — gather all keys first, then call this once with the whole list. `mode`: `now` (default: the first plays at once, the rest follow), `next` or `queue`. Pick the plain album version of a track unless a remaster, mix or live version is asked for. Only on an explicit request, never as a probe.',
    inputSchema: { keys: z.array(z.string()).min(1).max(60).describe('Track keys, in playing order.'), zone, mode },
    annotations: PLAYS,
  }, ({ keys, zone: zn, mode: m }) => run(() => ctl.playTracks(keys, zn, m ?? 'now')));

  reg('roon_play_radio', {
    title: 'Play a radio station',
    description: 'Play a Live Radio station on a Roon zone: `key` from roon_radio, or the name of one of the user\'s own stations. Says whether the zone started. Only on an explicit request, never as a probe.',
    inputSchema: { key: z.string().describe('A station key, or the name of an own station.'), zone },
    annotations: PLAYS,
  }, ({ key, zone: zn }) => run(() => rd.playRadio(key, zn)));

  reg('roon_control', {
    title: 'Transport',
    description: 'The buttons of a Roon zone: pause, play (resume), playpause, stop, next, previous — and release: let go of the audio device right away (what Roon does by itself a few seconds after a pause), so another source can use the speaker. Only on an explicit request, never as a probe.',
    inputSchema: { zone, action: z.enum(['pause', 'play', 'playpause', 'stop', 'next', 'previous', 'release']) },
    annotations: PLAYS,
  }, ({ zone: zn, action }) => run(() => (internal ? ctl.control(zn, action)
    : action === 'release' ? Promise.reject(new Error('release needs Roon\'s internal protocol (switched off)')) : off.control(zn, action))));

  reg('roon_seek', {
    title: 'Seek',
    description: 'Jump to a position in the track that plays on a Roon zone, in seconds from the start. Only on an explicit request.',
    inputSchema: { zone, seconds: z.number().int().min(0) },
    annotations: PLAYS,
  }, ({ zone: zn, seconds }) => run(() => (internal ? ctl.seek(zn, seconds) : off.seek(zn, seconds))));

  reg('roon_volume', {
    title: 'Volume',
    description: 'Set the volume of a Roon zone to an absolute level, in that zone\'s own scale (roon_now_playing shows `volume` and `volume_max`), and/or mute or unmute it. Only on an explicit request; small steps unless a level is named. Needs Deep Roon MCP enabled in Roon (Settings › Extensions).',
    inputSchema: { zone, level: z.number().optional(), mute: z.boolean().optional() },
    annotations: PLAYS,
  }, ({ zone: zn, level, mute }) => run(() => setVolume(zn, { value: level, mute })));

  reg('roon_settings', {
    title: 'Shuffle, repeat, Roon Radio',
    description: 'Shuffle, repeat and Roon Radio for a Roon zone — for the queue that is already there. To START an album shuffled, use `shuffle: true` on roon_play instead. `repeat`: off, all (the queue) or one (the track). `roon_radio`: on/off — whether Roon Radio keeps playing similar music when the queue ends — or `now` to start Roon Radio from what plays. Give only what should change. Only on an explicit request.',
    inputSchema: { zone, shuffle: z.boolean().optional(), repeat: z.enum(['off', 'all', 'one']).optional(), roon_radio: z.enum(['on', 'off', 'now']).optional() },
    annotations: PLAYS,
  }, ({ zone: zn, shuffle, repeat, roon_radio }) => { const s = { shuffle, repeat, roon_radio: roon_radio === undefined ? undefined : roon_radio === 'now' ? 'now' as const : roon_radio === 'on' }; return run(() => (internal ? ctl.settings(zn, s) : off.settings(zn, s))); });

  reg('roon_queue', {
    title: 'Queue',
    description: 'The queue of a Roon zone: the track that plays now (first row) and what comes after it, in order. Read this before answering what is queued, and before clearing.',
    inputSchema: { zone, limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ zone: zn, limit }) => run(() => ctl.queue(zn, limit ?? 50)));

  reg('roon_queue_jump', {
    title: 'Jump in the queue',
    description: 'Play an item of the zone\'s queue now (`n` as roon_queue numbers them: 1 is what plays, 2 the next …); what came before it is done. Pass the row\'s `item` from roon_queue too: positions shift when a track ends, the item doesn\'t. Only on an explicit request.',
    inputSchema: { zone, n: z.number().int().min(1), item: z.string().optional().describe('The row\'s `item` from roon_queue — finds that item even if the positions moved on, and refuses if it is gone.') },
    annotations: PLAYS,
  }, ({ zone: zn, n, item }) => run(() => ctl.queueJump(zn, n, item)));

  reg('roon_queue_remove', {
    title: 'Remove from the queue',
    description: 'Take items out of the zone\'s queue, by their numbers from roon_queue (`ns`, e.g. [3, 4]) — and preferably their `items` too: positions shift when a track ends, the items don\'t. Only on an explicit request.',
    inputSchema: { zone, ns: z.array(z.number().int().min(2)).min(1).max(100).describe('Positions from roon_queue (2 and up: 1 is what plays).'),
      items: z.array(z.string()).max(100).optional().describe('The rows\' `item` from roon_queue: exactly these are removed, and nothing if one is gone.') },
    annotations: CHANGES_QUEUE,
  }, ({ zone: zn, ns, items }) => run(() => ctl.queueRemove(zn, ns, items)));

  reg('roon_queue_move', {
    title: 'Move in the queue',
    description: 'Move an item of the zone\'s queue next to another: `n` goes `before` or `after` item `to` (numbers from roon_queue; 1 is what plays). Pass `item` and `to_item` from roon_queue too: positions shift when a track ends, items don\'t. Only on an explicit request.',
    inputSchema: { zone, n: z.number().int().min(2), to: z.number().int().min(2), where: z.enum(['before', 'after']).optional().describe('before (default) or after item `to`.'),
      item: z.string().optional().describe('The `item` of row n from roon_queue.'), to_item: z.string().optional().describe('The `item` of row `to` from roon_queue.') },
    annotations: CHANGES_QUEUE,
  }, ({ zone: zn, n, to, where, item, to_item }) => run(() => ctl.queueMove(zn, n, to, where ?? 'before', item, to_item)));

  reg('roon_queue_clear', {
    title: 'Clear the queue',
    description: 'Clear the queue of a Roon zone. By default the track that plays keeps playing and everything after it is removed; `everything: true` also removes the playing track (the zone falls silent). Only on an explicit request.',
    inputSchema: { zone, everything: z.boolean().optional() },
    annotations: REMOVES,
  }, ({ zone: zn, everything }) => run(() => ctl.queueClear(zn, everything === true)));

  reg('roon_transfer', {
    title: 'Transfer zone',
    description: 'Move what plays — with its queue and position — from one Roon zone to another (Roon\'s own "Transfer zone"). The tool for "move the music to …": never restart the album with roon_play for that. Read roon_now_playing first if the source zone isn\'t named.',
    inputSchema: { from: z.string().describe('The zone that plays now.'), to: z.string().describe('The zone it should move to.') },
    annotations: PLAYS,
  }, ({ from, to }) => run(() => (internal ? ctl.transfer(from, to) : off.transfer(from, to))));

  reg('roon_group', {
    title: 'Group zones',
    description: 'Group Roon zones so they play the same music in sync (Roon\'s own "Group zones"). `zone` keeps its music and queue; `with` are the zones that join. Roon groups only outputs of the same kind. Only on an explicit request.',
    inputSchema: { zone: z.string().describe('The zone whose music continues.'), with: z.array(z.string()).min(1).describe('The zones that join.') },
    annotations: PLAYS,
  }, (a) => run(() => (internal ? ctl.group(a.zone, a.with) : off.group(a.zone, a.with))));

  reg('roon_ungroup', {
    title: 'Ungroup zones',
    description: 'Undo a Roon zone group: `zone` is any member. Without `only` the whole group is dissolved; with `only` (a member\'s name) just that one leaves. Only on an explicit request.',
    inputSchema: { zone: z.string().describe('A member of the group.'), only: z.string().optional() },
    annotations: PLAYS,
  }, ({ zone: zn, only }) => run(() => (internal ? ctl.ungroup(zn, only) : off.ungroup(zn, only))));

  reg('roon_sleep', {
    title: 'Sleep timer',
    description: 'The sleep timer of a Roon zone: stop the music after `minutes` (1–600), or `off: true` to cancel it. roon_now_playing shows a running timer. Only on an explicit request ("stop in half an hour").',
    inputSchema: { zone, minutes: z.number().int().min(1).max(600).optional(), off: z.boolean().optional() },
    annotations: PLAYS,
  }, ({ zone: zn, minutes, off }) => run(async () => {
    if (!off && minutes === undefined) throw new Error('Give `minutes`, or `off: true`');
    return ctl.sleep(zn, off ? null : minutes!);
  }));

  reg('roon_standby', {
    title: 'Standby',
    description: 'Put a Roon zone\'s device in standby (`action: "standby"`) or wake it (`action: "wake"`), where the device supports it. Only on an explicit request.',
    inputSchema: { zone, action: z.enum(['standby', 'wake']) },
    annotations: PLAYS,
  }, ({ zone: zn, action }) => run(() => (internal ? ctl.standby(zn, action === 'standby') : off.standby(zn, action === 'standby'))));

  reg('roon_cover', {
    title: 'Cover',
    description: 'The album cover of what plays in a Roon zone, as an image (about 600 px), with the title in text. Without `zone` it takes the zone that plays. Read-only.',
    inputSchema: { zone: z.string().optional().describe('A Roon zone name (default: the zone that plays).') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ zone: zn }) => runImage(async () => (internal ? ctl.cover(zn) : off.cover(await findTarget(), zn))));
}
