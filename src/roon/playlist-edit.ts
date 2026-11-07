// Existing-playlist edits use only signatures present in the upstream authoritative catalog.
// See docs/playlist-editing.md. Never retry a write or roll it back after an uncertain result.
import { createHash } from 'node:crypto';
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { formatMethodSignature } from '../intern/catalog/signature';
import { withCore, RoonError } from '../core/session';
import { C, Any, field, obj, wait } from './graph';
import { playlistKey } from './tidal';
import { findTracks } from './library';
import { allPlaylists } from './more';

// Roon's sparse objects omit default false values. Accept that default only for a declared bool,
// after snapshotOn has validated the full native-playlist identity and membership.
export function writablePlaylist(c: C, p: Any): boolean {
  const ro = field(p, 'IsReadOnly');
  const declaredBool = c.graph.types.get(p.typeId)?.members.some(m => m.name.endsWith('::IsReadOnly') && m.propType === 2) === true;
  return field(p, 'Type') === 5 && (ro === false || (ro === undefined && declaredBool));
}

export interface Entry { id: string; key: string; oid: bigint }
export interface Snapshot { key: string; name: string; revision: string; entries: Entry[]; oid: bigint; service: bigint; writable: boolean }
export type Edit = { key: string; revision: string; confirm: true } & (
  { action: 'add'; keys: string[]; before?: string } |
  { action: 'remove'; items: string[] } |
  { action: 'reorder'; items: string[]; before?: string } |
  { action: 'rename'; name: string });
const invalid = (s: string): never => { throw new RoonError(s, 'invalid'); };
const trackKeyValid = (key: string) => /^(0|[1-9]\d{0,19})$/.test(key) && BigInt(key) <= 0xffffffffffffffffn;
const stable = (v: unknown): string => Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v : '';
export function revisionOf(key: string, name: string, entries: Pick<Entry, 'id' | 'key'>[]): string {
  return createHash('sha256').update(JSON.stringify([key, name, entries.map(e => [e.id, e.key])])).digest('hex');
}
/** The opt-in: '1' from the environment, 'true' from Claude Desktop's setting (0.5.7). */
export const playlistEditOn = () => ['1', 'true', 'on', 'yes'].includes((process.env.DEEP_ROON_PLAYLIST_EDIT ?? '').trim().toLowerCase());
function enabled() {
  const ro = (process.env.DEEP_ROON_READ_ONLY ?? '').trim().toLowerCase();
  if (ro && !['off', '0', 'false', 'no'].includes(ro)) invalid('Playlist editing is disabled by DEEP_ROON_READ_ONLY.');
  if (!playlistEditOn()) invalid('Playlist editing is experimental and disabled; see docs/playlist-editing.md.');
}

/** A fresh, complete membership query. No display limit, filtered rows or name fallback. */
export async function snapshotOn(c: C, key: string, timeoutMs = 3000): Promise<Snapshot> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(key)) invalid('Use the exact playlist key from roon_playlists.');
  const service = c.graph.findByType('Playlists')[0];
  if (!service) throw new RoonError('No playlists service', 'unavailable');
  const got = await c.call('Playlists', 'GetPlaylist', [{ type: 'Sooid', name: 'id' }, { type: 'ResultCallback<Playlist>', name: 'cb' }], buildArgs([Arg.sooid(Buffer.from(key, 'hex'))]), service.oid);
  if (!got.success) throw new RoonError(`Cannot read playlist (${got.status})`);
  const ref = c.graph.decodeReturnValue(Uint8Array.from(got.payload));
  if (!isRef(ref)) throw new RoonError('Playlist read returned no object');
  const end = Date.now() + timeoutMs;
  let p: Any;
  for (;;) {
    p = obj(c, ref);
    if (p && field(p, 'Name') !== undefined && playlistKey(p).toLowerCase() === key.toLowerCase()) break;
    if (Date.now() >= end) break;
    await wait(40);
  }
  if (!p || playlistKey(p).toLowerCase() !== key.toLowerCase() || typeof field(p, 'Name') !== 'string') throw new RoonError('Incomplete playlist identity');
  const result = await c.call('Playlist', 'GetItems', [{ type: 'ResultCallback<Query<PlaylistItem>>', name: 'cb' }], Buffer.alloc(0), p.oid);
  if (!result.success) throw new RoonError(`Cannot read playlist items (${result.status})`);
  const query = c.graph.decodeReturnValue(Uint8Array.from(result.payload));
  for (;;) {
    const q = obj(c, query); const f = q?.fields;
    if (f && Number.isInteger(f.$count) && f.$count >= 0 && Array.isArray(f.$items) && f.$items.length === f.$count) {
      const entries: Entry[] = [];
      for (const ref of f.$items) {
        const item = obj(c, ref); const track = obj(c, field(item, 'Track'));
        const id = stable(field(item, 'PlaylistItemId')); const trackKey = stable(field(track, 'TrackId'));
        if (!item || typeof item.oid !== 'bigint' || !id || !trackKeyValid(trackKey)) break;
        entries.push({ id, key: trackKey, oid: item.oid });
      }
      const count = field(p, 'ItemCount');
      if (entries.length === f.$count && count === entries.length && new Set(entries.map(e => e.id)).size === entries.length) {
        const name = field(p, 'Name'); const canonicalKey = playlistKey(p);
        return { key: canonicalKey, name, entries, oid: p.oid, service: service.oid,
          writable: writablePlaylist(c, p),
          revision: revisionOf(canonicalKey, name, entries) };
      }
    }
    if (Date.now() >= end) break;
    await wait(40);
  }
  throw new RoonError('Playlist membership is incomplete; no edit was attempted.');
}
export const publicSnapshot = (s: Snapshot) => ({ key: s.key, name: s.name, revision: s.revision, writable: s.writable,
  total: s.entries.length, items: s.entries.map(({ id, key }, i) => ({ n: i + 1, id, key })) });
export const playlistSnapshot = (key: string) => withCore(async c => publicSnapshot(await snapshotOn(c, key)));

export interface Plan { name: string; entries: Pick<Entry, 'id' | 'key'>[]; selected: Entry[]; anchor?: Entry; noop: boolean }
export function planEdit(s: Snapshot, edit: Edit): Plan {
  if (edit.confirm !== true) invalid('Explicit confirmation is required.');
  if (!s.writable) invalid('Only writable native Roon playlists can be edited.');
  if (s.key !== edit.key || s.revision !== edit.revision) invalid('Playlist changed since the snapshot; read a fresh snapshot and review the edit.');
  let name = s.name; let entries: Pick<Entry, 'id' | 'key'>[] = s.entries.slice(); let selected: Entry[] = [];
  if (edit.action === 'rename') {
    if (!edit.name.trim() || edit.name.length > 500) invalid('Choose a nonempty name of at most 500 characters.');
    name = edit.name;
  } else if (edit.action === 'add') {
    if (!edit.keys.length || edit.keys.length > 200 || edit.keys.some(k => !trackKeyValid(k))) invalid('Provide 1–200 valid track keys.');
    const at = edit.before === undefined ? entries.length : entries.findIndex(e => e.id === edit.before);
    if (at < 0) invalid('Insertion anchor is no longer in the playlist.');
    entries.splice(at, 0, ...edit.keys.map(key => ({ id: '', key })));
  } else {
    if (!edit.items.length || edit.items.length > 200 || new Set(edit.items).size !== edit.items.length) invalid('Provide 1–200 distinct playlist item ids.');
    // Selected occurrences keep their original playlist order (not caller order).
    selected = s.entries.filter(e => edit.items.includes(e.id));
    if (selected.length !== edit.items.length) invalid('A selected item is no longer in the playlist.');
    entries = entries.filter(e => !edit.items.includes(e.id));
    if (edit.action === 'reorder') {
      if (edit.before !== undefined && edit.items.includes(edit.before)) invalid('The anchor cannot be one of the moved items.');
      const at = edit.before === undefined ? entries.length : entries.findIndex(e => e.id === edit.before);
      if (at < 0) invalid('Move anchor is no longer in the playlist.');
      entries.splice(at, 0, ...selected);
    }
  }
  const anchor = 'before' in edit && edit.before !== undefined ? s.entries.find(e => e.id === edit.before) : undefined;
  const noop = name === s.name && JSON.stringify(entries.map(e => [e.id, e.key])) === JSON.stringify(s.entries.map(e => [e.id, e.key]));
  return { name, entries, selected, anchor, noop };
}
export function matchesPlan(after: Snapshot, before: Snapshot, plan: Plan): boolean {
  if (after.key !== before.key || after.name !== plan.name || after.entries.length !== plan.entries.length) return false;
  // Existing occurrence identities must survive, including duplicate tracks. New rows receive new ids from Roon.
  const oldIds = new Set(before.entries.map(e => e.id));
  return after.entries.every((e, i) => e.key === plan.entries[i].key && (plan.entries[i].id ? e.id === plan.entries[i].id : !oldIds.has(e.id)));
}
export interface EditIO {
  read(): Promise<Snapshot>;
  validateTracks(keys: string[]): Promise<unknown>;
  write(before: Snapshot, plan: Plan, edit: Edit): Promise<void>;
  pause(): Promise<unknown>;
  /** Whether another playlist already has this name: Roon refuses a rename onto it (overwrite=false). */
  nameTaken?(name: string, key: string): Promise<boolean>;
}
/** Injected IO makes refusal, partial application and delayed pushes testable without a live Core. */
export async function executeEdit(io: EditIO, edit: Edit, attempts = 12) {
  const before = await io.read(); const plan = planEdit(before, edit);
  if (plan.noop) return { ok: true, verified: true, unchanged: true, ...publicSnapshot(before) };
  if (edit.action === 'add') await io.validateTracks(edit.keys);
  // Said plainly before writing, instead of an 'uncertain' after Roon's refusal (0.5.7).
  if (edit.action === 'rename' && io.nameTaken && await io.nameTaken(plan.name, before.key)) invalid(`Another playlist is already called "${plan.name}"; choose another name.`);
  // Recheck after asynchronous validation, before issuing the single write.
  const checked = await io.read();
  if (checked.revision !== before.revision || !checked.writable) invalid('Playlist changed before the write; read a fresh snapshot.');
  const finalPlan = planEdit(checked, edit);
  let uncertain: unknown;
  try { await io.write(checked, finalPlan, edit); } catch (e) { uncertain = e; }
  let after: Snapshot | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      after = await io.read();
      if (matchesPlan(after, checked, finalPlan)) return { ok: true, verified: true, ...publicSnapshot(after),
        note: uncertain ? 'The write response was uncertain; a fresh read verified the exact requested result.' : undefined };
    } catch { /* The write may have happened; only a complete matching read can confirm it. */ }
    if (i + 1 < attempts) await io.pause();
  }
  return { ok: false, verified: false, outcome: 'uncertain', key: edit.key,
    note: 'The requested result could not be verified. Do not retry automatically. Read a fresh snapshot and inspect Roon before another edit.',
    observed: after ? publicSnapshot(after) : undefined };
}
export async function writeOn(c: C, s: Snapshot, p: Plan, edit: Edit): Promise<void> {
  const selected = Arg.collection(p.selected.map(e => buildArgs([Arg.ref(e.oid)])));
  const at = [Arg.enum_(p.anchor ? 3 : 1), Arg.ref(p.anchor?.oid ?? 0n)]; // Before / End (authoritative enum)
  const playlist = { type: 'Playlist', name: 'playlist' };
  const collection = { type: 'IEnumerable<PlaylistItem>', name: 'items' };
  const where = [{ type: 'InsertionPoint', name: 'insertionpoint' }, { type: 'PlaylistItem', name: 'relative_to_item' }];
  if (edit.action === 'remove') {
    // There is no ResultCallback overload; asking for a reply would hang.
    c.remoting.callMethodNoReply(s.service, formatMethodSignature('Playlists', 'RemoveItems', [playlist, collection]), buildArgs([Arg.ref(s.oid), selected]));
    return;
  }
  const method = edit.action === 'add' ? 'InsertMedia' : edit.action === 'reorder' ? 'MoveItems' : 'Rename';
  const params = edit.action === 'add' ? [playlist, { type: 'IEnumerable<long>', name: 'mediaids' }, ...where, { type: 'ResultCallback<PlaylistInsertionResult>', name: 'cb' }]
    : edit.action === 'reorder' ? [playlist, collection, ...where, { type: 'ResultCallback', name: 'cb' }]
    : [playlist, { type: 'string', name: 'name' }, { type: 'bool', name: 'overwrite_on_duplicate_name' }, { type: 'ResultCallback', name: 'cb' }];
  const args = edit.action === 'add' ? [Arg.ref(s.oid), Arg.collection(edit.keys.map(k => buildArgs([Arg.long(BigInt(k))]))), ...at]
    : edit.action === 'reorder' ? [Arg.ref(s.oid), selected, ...at] : [Arg.ref(s.oid), Arg.str(edit.name), Arg.bool(false)];
  const result = await c.call('Playlists', method, params, buildArgs(args), s.service);
  if (!result.success) throw new RoonError(`Roon refused playlist edit (${result.status}); checking the saved result.`);
}
export const playlistEdit = (edit: Edit) => {
  enabled();
  return withCore(c => executeEdit({ read: () => snapshotOn(c, edit.key), validateTracks: keys => findTracks(c, keys),
    write: (s, p, e) => writeOn(c, s, p, e), pause: () => wait(150),
    nameTaken: async (name, key) => allPlaylists(c).list.some(p => playlistKey(p).toLowerCase() !== key.toLowerCase()
      && String(field(p, 'Name') ?? '').trim().toLowerCase() === name.trim().toLowerCase()) }, edit));
};
