// The self-test: a few reads through the internal protocol, each one standing for a group of tools. Read-only.
import type { Check } from '../core/status';
import * as lib from './library';
import * as focus from './focus';

async function timed(name: string, affects: string, f: () => Promise<string | undefined>): Promise<Check> {
  const t0 = Date.now();
  try {
    const detail = await f(), ms = Date.now() - t0;
    // Slow isn't broken (issue #4): a large library, or a Core that just updated, can take many seconds and still work.
    const slow = ms > 8000 ? ` — works, but slow (${Math.round(ms / 1000)} s): a large library, or a Core that just updated` : '';
    return { name, ok: true, ms, detail: detail === undefined ? (slow ? slow.slice(3) : undefined) : detail + slow, affects };
  }
  catch (e) { return { name, ok: false, ms: Date.now() - t0, detail: (e as Error).message, affects }; }
}

export async function runSelfTest(): Promise<Check[]> {
  const out: Check[] = [];
  let albumKey: string | undefined;
  // The probe comes from the library itself (issue #3, 15 Nov 2026): a fixed name ("Miles Davis") found nothing on a
  // local-only library without a streaming service, and the self-test called search broken while it worked.
  out.push(await timed('search', 'roon_search and everything that starts from a key', async () => {
    const first = (await focus.library({}, 'added', false, 1, 0)).rows[0] as { title?: string; key?: string } | undefined;
    if (!first?.title) {
      albumKey = undefined;
      return 'nothing to search for (an empty library) — not tested';
    }
    const r = await lib.search(first.title, 5, 'album');
    albumKey = (r.rows[0] as { key?: string } | undefined)?.key ?? first.key;
    if (!r.rows.length) throw new Error(`no results for "${first.title}", an album in this library`);
    return `${r.rows.length} album${r.rows.length === 1 ? '' : 's'} for "${first.title}"`;
  }));
  out.push(await timed('album page', 'roon_album, roon_review, roon_versions, roon_similar', async () => {
    if (!albumKey) return 'no album to open (an empty library) — not tested';
    const a = await lib.album(albumKey, false);
    if (!a.tracks?.length) throw new Error('an album without tracks');
    return `${a.tracks.length} tracks`;
  }));
  out.push(await timed('streaming shelf', 'roon_new, roon_genres, roon_artist, roon_tidal_playlists', async () => {
    try { const s = await lib.section('new', 1, 0); return `${s.total ?? '?'} new albums at ${s.service}`; }
    catch (e) { if (/Neither Qobuz nor TIDAL/i.test((e as Error).message)) return 'no Qobuz or TIDAL signed in on this Core (not an error)'; throw e; }
  }));
  return out;
}
