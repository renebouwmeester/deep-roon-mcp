import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeEdit, planEdit, revisionOf, matchesPlan, snapshotOn, writeOn, playlistEdit, writablePlaylist, type Snapshot, type Edit, type Entry } from '../src/roon/playlist-edit';
import { registerPlaylistEditTools, PLAYLIST_WRITES } from '../src/tools/playlist-edit';
import { formatMethodSignature } from '../src/intern/catalog/signature';
import fixture from './fixtures/playlist-protocol.json';
const baseEntries: Entry[] = [{ id: 'a', key: '11', oid: 10n }, { id: 'b', key: '22', oid: 11n }, { id: 'c', key: '11', oid: 12n }];
function state(entries = baseEntries, name = 'Original'): Snapshot {
  return { key: 'aa', name, entries, writable: true, oid: 2n, service: 1n, revision: revisionOf('aa', name, entries) };
}
const request = (x: object): Edit => ({ key: 'aa', revision: state().revision, confirm: true, ...x } as Edit);
const remove = request({ action: 'remove', items: ['a'] });
const add = request({ action: 'add', keys: ['11', '33'], before: 'b' });
const reorder = request({ action: 'reorder', items: ['c'], before: 'a' });
const rename = request({ action: 'rename', name: 'New' });
for (const [title, edit, keys] of [
  ['remove one duplicate occurrence', remove, ['22', '11']],
  ['add ordered duplicates before anchor', add, ['11', '11', '33', '22', '11']],
  ['reorder duplicate occurrence', reorder, ['11', '11', '22']],
  ['rename preserves all occurrences', rename, ['11', '22', '11']],
] as const) test(title, () => assert.deepEqual(planEdit(state(), edit).entries.map(e => e.key), keys));
test('move multiple occurrences in playlist order, not caller order', () => {
  assert.deepEqual(planEdit(state(), request({ action: 'reorder', items: ['c', 'a'] })).entries.map(e => e.id), ['b', 'a', 'c']);
});
for (const [title, s, edit] of [
  ['stale revision', state(), { ...remove, revision: 'stale' }],
  ['wrong playlist key', state(), { ...remove, key: 'bb' }],
  ['read only playlist', { ...state(), writable: false }, remove],
  ['confirmation missing', state(), { ...remove, confirm: false }],
  ['unknown occurrence', state(), request({ action: 'remove', items: ['z'] })],
  ['duplicate occurrence selection', state(), request({ action: 'remove', items: ['a', 'a'] })],
  ['selected move anchor', state(), request({ action: 'reorder', items: ['a'], before: 'a' })],
  ['missing move anchor', state(), request({ action: 'reorder', items: ['a'], before: 'z' })],
  ['missing add anchor', state(), request({ action: 'add', keys: ['11'], before: 'z' })],
  ['blank rename', state(), request({ action: 'rename', name: '  ' })],
  ['overflowing track id', state(), request({ action: 'add', keys: ['18446744073709551616'] })],
  ['noncanonical track id', state(), request({ action: 'add', keys: ['011'] })],
  ['malformed track id', state(), request({ action: 'add', keys: ['11x'] })],
] as const) test('rejects ' + title, () => assert.throws(() => planEdit(s, edit as Edit)));
test('revision covers ordered occurrence identity and names', () => {
  assert.notEqual(state().revision, state([...baseEntries].reverse()).revision);
  assert.notEqual(state().revision, state(baseEntries, 'New').revision);
});
function harness(edit: Edit, options: { delay?: number; uncertain?: boolean; partial?: boolean; concurrent?: boolean; invalidTrack?: boolean; unreadable?: boolean } = {}) {
  let writes = 0, reads = 0; let current = state(); let target = current;
  const io = { read: async () => { reads++; if (options.concurrent && reads === 2) current = state(baseEntries, 'Other');
    if (writes && options.unreadable) throw Error('read failed');
    if (writes && reads > 2 + (options.delay ?? 0)) current = target; return current; },
    validateTracks: async () => { if (options.invalidTrack) throw Error('unknown track'); }, pause: async () => {},
    write: async (s: Snapshot, p: ReturnType<typeof planEdit>) => { writes++;
      target = state(options.partial ? baseEntries.slice(0, 1) : p.entries.map((e, i) => ({ ...e, id: e.id || 'new' + i, oid: BigInt(i + 50) })), p.name);
      if (options.uncertain) throw Error('connection lost'); } };
  return { io, counts: () => ({ writes, reads }) };
}
for (const edit of [remove, add, reorder, rename]) test('verified read-after-write: ' + edit.action, async () => {
  const h = harness(edit, { delay: 1 }); const result = await executeEdit(h.io, edit, 4);
  assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(h.counts().writes, 1); assert.ok(h.counts().reads >= 4);
});
test('ambiguous response may be verified without replaying write', async () => {
  const h = harness(remove, { uncertain: true }); assert.equal((await executeEdit(h.io, remove, 3)).ok, true); assert.equal(h.counts().writes, 1);
});
for (const options of [{ partial: true }, { unreadable: true }, { delay: 100 }]) test('partial/failed/delayed read never succeeds or retries', async () => {
  const h = harness(remove, options); const r = await executeEdit(h.io, remove, 3);
  assert.equal(r.ok, false); assert.equal(r.outcome, 'uncertain'); assert.equal(h.counts().writes, 1);
});
test('concurrent change caught immediately before write', async () => {
  const h = harness(add, { concurrent: true }); await assert.rejects(executeEdit(h.io, add), /changed before/); assert.equal(h.counts().writes, 0);
});
test('unknown added track causes no write', async () => {
  const h = harness(add, { invalidTrack: true }); await assert.rejects(executeEdit(h.io, add)); assert.equal(h.counts().writes, 0);
});
test('rename onto a name another playlist has is refused before any write', async () => {
  const edit = request({ action: 'rename', name: 'Taken' }); const h = harness(edit);
  await assert.rejects(executeEdit({ ...h.io, nameTaken: async (n: string) => n === 'Taken' }, edit), /already called/); assert.equal(h.counts().writes, 0);
});
test('no-op rename never writes', async () => {
  const edit = request({ action: 'rename', name: 'Original' }); const h = harness(edit);
  assert.equal((await executeEdit(h.io, edit)).ok, true); assert.equal(h.counts().writes, 0);
});
test('same track sequence with replaced old occurrence ids fails verification', () => {
  const p = planEdit(state(), remove); assert.equal(matchesPlan(state(p.entries.map((e, i) => ({ ...e, id: 'different' + i, oid: 50n }))), state(), p), false);
});
test('wire signatures match independently sourced authoritative catalog; removal sends no reply', async () => {
  const calls: any[] = [];
  const c: any = { call: async (service: string, method: string, params: any, bytes: Buffer, oid: bigint) => {
    calls.push({ method, sig: formatMethodSignature(service, method, params), bytes, oid }); return { success: true }; },
    remoting: { callMethodNoReply: (oid: bigint, sig: string, bytes: Buffer) => calls.push({ method: 'RemoveItems', sig, oid, bytes, noReply: true }) } };
  for (const edit of [remove, add, reorder, rename]) await writeOn(c, state(), planEdit(state(), edit), edit);
  for (const call of calls) { assert.ok(fixture.signatures[call.method as keyof typeof fixture.signatures].includes(call.sig)); assert.equal(call.oid, 1n); }
  // Small positive ids/lengths use one-byte varints. These literals independently fix argument order,
  // ref collection framing, Before=3, End=1 and overwrite=false.
  assert.deepEqual(calls.map(c => c.bytes.toString('hex')), ['0202010a', '0203020b21030b', '0202010c030a', '02034e657700']);
  assert.equal(calls[0].noReply, true);
});
function graphCore(options: { count?: number; itemCount?: number; readOnly?: boolean; type?: number; missingTrack?: boolean; empty?: boolean } = {}) {
  const entries = options.empty ? [] : baseEntries;
  const objects = new Map<bigint, any>();
  const p = { oid: 2n, fields: { 'P::PlaylistId': Buffer.from('aa', 'hex'), 'P::Name': 'Original', 'P::Type': options.type ?? 5,
    'P::IsReadOnly': options.readOnly ?? false, 'P::ItemCount': options.itemCount ?? entries.length } };
  objects.set(2n, p);
  objects.set(3n, { fields: { $count: options.count ?? entries.length, $items: entries.map(e => ({ $ref: e.oid })) } });
  for (const e of entries) { objects.set(e.oid, { oid: e.oid, fields: { 'I::PlaylistItemId': e.id, 'I::Track': { $ref: e.oid + 100n } } });
    if (!options.missingTrack) objects.set(e.oid + 100n, { fields: { 'T::TrackId': BigInt(e.key) } }); }
  const calls: any[] = [];
  return { calls, core: { graph: { objects, types: new Map(), findByType: () => [{ oid: 1n }], getObject: (id: bigint) => objects.get(id), decodeReturnValue: (b: Buffer) => ({ $ref: BigInt(b[0]) }) },
    call: async (...args: any[]) => { calls.push(args); return { success: true, payload: Buffer.from([args[1] === 'GetPlaylist' ? 2 : 3]) }; } } as any };
}
test('snapshot freshly resolves playlist and complete occurrence list without display truncation', async () => {
  const h = graphCore(); const s = await snapshotOn(h.core, 'aa', 0); assert.equal(s.entries.length, 3); assert.equal(s.writable, true);
  assert.deepEqual(h.calls.map(c => c[1]), ['GetPlaylist', 'GetItems']); assert.equal(h.calls[0][2][0].type, 'Sooid');
});
test('snapshot accepts a fully loaded empty playlist', async () => assert.equal((await snapshotOn(graphCore({ empty: true }).core, 'aa', 0)).entries.length, 0));
for (const options of [{ count: 4 }, { itemCount: 4 }, { missingTrack: true }]) test('incomplete snapshot refuses to target edits', async () => {
  await assert.rejects(snapshotOn(graphCore(options).core, 'aa', 0), /incomplete/);
});
for (const options of [{ readOnly: true }, { type: 10 }, { type: 12 }, { type: 15 }]) test('imported/read-only/smart playlist is never writable', async () => {
  assert.equal((await snapshotOn(graphCore(options).core, 'aa', 0)).writable, false);
});
test('schema-declared sparse false is writable only for native playlists', () => {
  const c: any = { graph: { types: new Map([[1, { members: [{ name: 'bool P::IsReadOnly', propType: 2 }] }]]) } };
  const p: any = { typeId: 1, fields: { 'P::Type': 5 } };
  assert.equal(writablePlaylist(c, p), true);
  p.fields['P::IsReadOnly'] = true; assert.equal(writablePlaylist(c, p), false);
  delete p.fields['P::IsReadOnly']; p.fields['P::Type'] = 12; assert.equal(writablePlaylist(c, p), false);
  p.fields['P::Type'] = 5; p.typeId = 2; assert.equal(writablePlaylist(c, p), false);
  c.graph.types.set(2, { members: [{ name: 'P::IsReadOnly', propType: 20 }] }); assert.equal(writablePlaylist(c, p), false);
});

test('tools default off, explicit opt-in exposes four writes; read snapshot remains', () => {
  const old = process.env.DEEP_ROON_PLAYLIST_EDIT;
  try {
    for (const enabled of [false, true]) { if (enabled) process.env.DEEP_ROON_PLAYLIST_EDIT = '1'; else delete process.env.DEEP_ROON_PLAYLIST_EDIT;
      const names: string[] = []; registerPlaylistEditTools({ registerTool: (name: string) => names.push(name) } as any);
      assert.ok(names.includes('roon_playlist_snapshot')); assert.equal(names.filter(n => PLAYLIST_WRITES.includes(n)).length, enabled ? 4 : 0); }
  } finally { if (old === undefined) delete process.env.DEEP_ROON_PLAYLIST_EDIT; else process.env.DEEP_ROON_PLAYLIST_EDIT = old; }
});
test('runtime read-only and opt-in guards reject before any Core connection', () => {
  const oldRo = process.env.DEEP_ROON_READ_ONLY, oldFlag = process.env.DEEP_ROON_PLAYLIST_EDIT;
  try {
    process.env.DEEP_ROON_PLAYLIST_EDIT = '1'; process.env.DEEP_ROON_READ_ONLY = 'library'; assert.throws(() => playlistEdit(remove), /READ_ONLY/);
    process.env.DEEP_ROON_READ_ONLY = 'all'; assert.throws(() => playlistEdit(remove), /READ_ONLY/);
    delete process.env.DEEP_ROON_READ_ONLY; delete process.env.DEEP_ROON_PLAYLIST_EDIT; assert.throws(() => playlistEdit(remove), /disabled/);
  } finally {
    if (oldRo === undefined) delete process.env.DEEP_ROON_READ_ONLY; else process.env.DEEP_ROON_READ_ONLY = oldRo;
    if (oldFlag === undefined) delete process.env.DEEP_ROON_PLAYLIST_EDIT; else process.env.DEEP_ROON_PLAYLIST_EDIT = oldFlag;
  }
});
