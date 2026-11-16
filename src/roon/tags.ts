// Tags (16 Nov 2026, a user: "Is there any way to set tags remotely?" — "look up all albums that are Target CDs and tag them
// as such"). Roon's own tags through the internal protocol: the list (Library::GetAllTagLites), the tags of an album (its
// Tags), and albums into or out of a tag (Library::EditTag with EditTagParameters → EditExplicitTag → AddAlbums /
// RemoveAlbums), creating the tag first when asked (Library::CreateTag). Signatures from the authoritative catalog
// (arthursoares/roon-api-reverse-engineering @ 8b67208). Every write is read back.
import { isRef } from '../intern';
import { Arg, buildArgs } from '../intern/proto/serializer';
import { BinaryWriter } from '../intern/proto/writer';
import { withCore, RoonError } from '../core/session';
import { Any, C, field, items, obj, untilLoaded, wait } from './graph';
import { findAlbum } from './library';
import { profileObject, decoded } from './more';

const invalid = (s: string): never => { throw new RoonError(s, 'invalid'); };
const tagKey = (t: Any) => { const id = field(t, 'TagId'); return Buffer.isBuffer(id) ? id.toString('hex') : String(id ?? ''); };
const isExplicit = (t: Any) => /ExplicitTag(Lite)?$/.test(t?.typeName ?? '');
const row = (t: Any) => ({ key: tagKey(t), name: field(t, 'Name') ?? '', kind: isExplicit(t) ? 'tag' : 'smart tag',
  ...(typeof field(t, 'ItemCount') === 'number' ? { items: field(t, 'ItemCount') } : {}),
  ...(field(t, 'IsReadOnly') === true ? { read_only: true } : {}) });
// A list inside a struct: its byte length, then the count and the object ids (as Focus passes RequireLocations).
const refList = (oids: bigint[]) => { const w = new BinaryWriter().flexInt(oids.length); for (const x of oids) w.long(x); const b = w.toBuffer(); return new BinaryWriter().integer(b.length).bytes(b).toBuffer(); };

async function allTags(c: C): Promise<Any[]> {
  const res = await c.call('Library', 'GetAllTagLites',
    [{ type: 'Profile', name: 'profile' }, { type: 'ResultCallback<DataList<TagLite>>', name: 'cb_result' }],
    buildArgs([Arg.ref(profileObject(c).oid)]), c.serviceOid('Library'));
  if (!res.success) throw new RoonError(`Roon refused the list of tags (${res.status})`);
  const list = items(c, decoded(c, res.payload));
  await untilLoaded(c, list.map((t) => ({ $ref: t.oid })), 2500);
  return list;
}

/** Every tag of the profile: name, key, how many items, and whether it's a smart tag (those can't be edited by hand). */
export async function tags() {
  return withCore(async (c) => {
    const all = await allTags(c);
    return { count: all.length, tags: all.map(row).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  });
}

async function tagsOfAlbum(c: C, al: Any): Promise<string[]> {
  const v = field(al, 'Tags');
  const list = isRef(v) ? items(c, v) : (v?.$items ?? []).map((x: Any) => obj(c, x)).filter(Boolean);
  await untilLoaded(c, list.map((t: Any) => ({ $ref: t.oid })), 1500);
  return list.map((t: Any) => String(field(t, 'Name') ?? '')).filter(Boolean);
}

/** The tags of one album. */
export async function albumTags(key: string) {
  return withCore(async (c) => {
    const al = await findAlbum(c, key);
    return { key, title: field(al, 'Title'), tags: await tagsOfAlbum(c, al) };
  });
}

/** Albums into a tag (or out of it with `remove`). `create`: make the tag when no tag has that name. */
export async function tagAlbums(name: string, keys: string[], opts: { remove?: boolean; create?: boolean; confirm: boolean }) {
  if (!opts.confirm) invalid('Tagging changes the library: pass confirm: true, after the user agreed to these albums and this tag.');
  const wanted = name.trim();
  if (!wanted) invalid('A tag name, please.');
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (!unique.length) invalid('No album keys.');
  if (unique.length > 500) invalid('At most 500 albums at a time.');
  return withCore(async (c) => {
    const albums: Any[] = [];
    for (const k of unique) albums.push(await findAlbum(c, k));
    const lib = c.serviceOid('Library');
    let all = await allTags(c);
    let tag = all.find((t) => String(field(t, 'Name') ?? '').toLowerCase() === wanted.toLowerCase());
    let created = false;
    if (!tag) {
      if (opts.remove) invalid(`There is no tag called "${wanted}".`);
      if (!opts.create) invalid(`There is no tag called "${wanted}" yet — pass create: true to make it.`);
      const params = c.structArg('Sooloos.Broker.Api.CreateTagParameters', [
        { name: 'Name', propType: 20, value: new BinaryWriter().string(wanted).toBuffer() },
        { name: 'Profile', propType: 23, value: new BinaryWriter().long(profileObject(c).oid).toBuffer() }]);
      const res = await c.call('Library', 'CreateTag',
        [{ type: 'CreateTagParameters', name: 'parameters' }, { type: 'ResultCallback<CreateTagResult>', name: 'cb_result' }], params, lib);
      if (!res.success) throw new RoonError(`Roon refused to create the tag (${res.status})`);
      for (let i = 0; i < 20 && !tag; i++) {
        await wait(150);
        all = await allTags(c);
        tag = all.find((t) => String(field(t, 'Name') ?? '').toLowerCase() === wanted.toLowerCase());
      }
      if (!tag) throw new RoonError(`Roon said the tag was created, but "${wanted}" isn't in the list`);
      created = true;
    }
    if (!isExplicit(tag)) invalid(`"${field(tag, 'Name')}" is a smart tag: Roon fills it from its rules, it can't be edited by hand.`);
    if (field(tag, 'IsReadOnly') === true) invalid(`"${field(tag, 'Name')}" is read-only.`);
    const explicit = c.structArg('Sooloos.Broker.Api.EditExplicitTagParameters', [
      { name: opts.remove ? 'RemoveAlbums' : 'AddAlbums', propType: 23, value: refList(albums.map((a) => a.oid)) }]);
    const edit = c.structArg('Sooloos.Broker.Api.EditTagParameters', [{ name: 'EditExplicitTag', propType: 23, value: explicit }]);
    const res = await c.call('Library', 'EditTag',
      [{ type: 'TagBase', name: 'tag' }, { type: 'EditTagParameters', name: 'parameters' }, { type: 'ResultCallback<EditTagResult>', name: 'cb_result' }],
      Buffer.concat([buildArgs([Arg.ref(tag.oid)]), edit]), lib);
    if (!res.success) throw new RoonError(`Roon refused the change to "${field(tag, 'Name')}" (${res.status})`);
    // Read back: every album's own tags.
    await wait(500);
    const rows: Any[] = [];
    let ok = 0;
    for (const a of albums) {
      const fresh = await findAlbum(c, String(field(a, 'AlbumId')));
      const has = (await tagsOfAlbum(c, fresh)).some((n) => n.toLowerCase() === wanted.toLowerCase());
      const good = opts.remove ? !has : has;
      if (good) ok++;
      rows.push({ key: String(field(a, 'AlbumId')), title: field(a, 'Title'), tagged: has });
    }
    return { tag: field(tag, 'Name'), created: created || undefined, action: opts.remove ? 'removed' : 'added', albums: unique.length,
             confirmed: ok, ...(ok < unique.length ? { note: `Roon said ok; ${unique.length - ok} album(s) didn't read back as ${opts.remove ? 'untagged' : 'tagged'}` } : {}),
             rows };
  });
}

/** A tag away (Library::DeleteTag): by its name, explicit or smart; the albums themselves stay. Read back from the list. */
export async function deleteTag(name: string, confirm: boolean) {
  if (!confirm) invalid('Deleting a tag can\'t be undone: pass confirm: true, after the user agreed.');
  const wanted = name.trim();
  if (!wanted) invalid('A tag name, please.');
  return withCore(async (c) => {
    const tag = (await allTags(c)).find((t) => String(field(t, 'Name') ?? '').toLowerCase() === wanted.toLowerCase());
    if (!tag) invalid(`There is no tag called "${wanted}".`);
    if (field(tag, 'IsDeletable') === false || field(tag, 'IsReadOnly') === true) invalid(`Roon doesn't allow deleting "${field(tag, 'Name')}".`);
    const res = await c.call('Library', 'DeleteTag', [{ type: 'TagBase', name: 'tag' }, { type: 'ResultCallback', name: 'cb_result' }],
      buildArgs([Arg.ref(tag.oid)]), c.serviceOid('Library'));
    if (!res.success) throw new RoonError(`Roon refused to delete "${field(tag, 'Name')}" (${res.status})`);
    let gone = false;
    for (let i = 0; i < 10 && !gone; i++) {
      await wait(200);
      gone = !(await allTags(c)).some((t) => String(field(t, 'Name') ?? '').toLowerCase() === wanted.toLowerCase());
    }
    return { tag: field(tag, 'Name'), deleted: gone, ...(gone ? {} : { note: 'Roon said ok, but the tag is still in the list' }) };
  });
}
