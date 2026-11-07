// The connection with the Core over the internal protocol, as Roon Labs asked in the forum: short-lived — opened for a
// question, closed after two minutes of quiet —, one at a time, and the questions one after another. While open, the
// client sends a PING every 10 s (the Core drops a silent session after 30–35 s; see src/intern).
//
// Objects are only valid within one connection; the ids (AlbumId, TrackId, PerformerId) aren't — an id from an earlier
// connection is fetched from the Core again (see roon/library.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import { RoonClient } from '../intern';
import { brokerId, coreInfo, findCores } from './discover';
import { RoonError, Target } from './errors';
import { paired, startOfficial } from './official';
import { log } from './log';

export { RoonError } from './errors';

const IDLE_MS = 120_000;
const INTERNAL_PORT = 9332;

let target: Target | null = null;
let client: RoonClient | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Runs once, after the first connection (the self-test, set by index.ts). */
let onFirstConnect: (() => Promise<void>) | null = null;
export function afterFirstConnect(f: () => Promise<void>): void { onFirstConnect = f; }
// The Roon profile (7 Nov 2026, forum: "after switching profiles in Roon, roon_history still returns the history of my
// first profile"). Each Roon app is a remote with its own profile; so is Deep Roon. ROON_PROFILE (a name) chooses it
// for everything; a tool's `profile` argument for one question — carried through the call's awaits by
// AsyncLocalStorage, so a function that waits, or opens a fresh connection (the history), keeps it. Neither: the first.
const asked = new AsyncLocalStorage<string>();
export function asProfile<T>(name: string | undefined, work: () => Promise<T>): Promise<T> { return name?.trim() ? asked.run(name.trim(), work) : work(); }
let wanted: string | undefined;
/** The profiles the Core sends with the graph, in its own order: name and id. */
export function profilesOf(c: RoonClient): { name: string; id: Buffer }[] {
  const list = [...c.graph.objects.values()].find((o) => /\.DataList<[\w.]*\.Profile>$/.test(o.typeName));
  const objs = list ? ((list.fields.$items as { $ref: bigint }[] | undefined) ?? []).map((r) => c.graph.getObject(r.$ref)) : [...c.graph.objects.values()].filter((o) => o.typeName.endsWith('.Profile'));
  const field = (o: { fields: Record<string, unknown> }, n: string) => Object.entries(o.fields).find(([k]) => k.endsWith(`::${n}`) || k === n)?.[1];
  return objs.filter(Boolean).map((o) => ({ name: String(field(o!, 'Name') ?? ''), id: field(o!, 'ProfileId') as Buffer })).filter((p) => p.name && Buffer.isBuffer(p.id));
}
function chooseProfile(c: RoonClient): void {
  const name = wanted ?? (process.env.ROON_PROFILE?.trim() || undefined);
  if (!name) { c.useProfile(undefined); return; }
  const all = profilesOf(c), p = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) throw new RoonError(`No Roon profile called "${name}" — the profiles: ${all.map((x) => x.name).join(', ') || 'none found'}`, 'invalid');
  c.useProfile(p.id);
}
/** The profile in use now (by name): for roon_profiles. */
export function profileInUse(c: RoonClient): string | undefined {
  const id = c.profile();
  return profilesOf(c).find((p) => p.id.equals(id))?.name;
}

/** What's known now, without connecting. */
export const knownTarget = (): Target | null => target;

/** The Core: ROON_HOST ("host" or "host:port", the extension API's port) or the local network. */
let finding: Promise<Target> | null = null;
export function findTarget(): Promise<Target> {
  if (target) return Promise.resolve(target);
  // One search at a time: the start of the server and the first tool may ask together.
  finding ??= locate().finally(() => { finding = null; });
  return finding;
}
async function locate(): Promise<Target> {
  const configured = process.env.ROON_HOST?.trim();
  let host: string, port: number;
  if (configured) {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(configured);
    host = m?.[1] ?? configured; port = Number(m?.[2] ?? 9330);
  } else {
    const cores = await findCores();
    if (!cores.length) {
      // macOS 15 and later: an app needs the user's permission for the local network, and Claude Desktop runs this with its
      // own Node — without it the search finds nothing, silently (12 Oct, René's Mac: Claude asked, he allowed, found).
      const mac = process.platform === 'darwin' ? ' On a Mac, check System Settings › Privacy & Security › Local Network: the app that runs Deep Roon MCP must be allowed (for Claude Desktop: Claude and Claude Helper).' : '';
      throw new RoonError(`No Roon Core found on this network.${mac} On another network (a VPN, Tailscale), set ROON_HOST to the Core's address.`, 'unavailable');
    }
    if (cores.length > 1) log(`found ${cores.length} Roon Cores (${cores.map((c) => c.name ?? c.host).join(', ')}) — using ${cores[0].name ?? cores[0].host}; set ROON_HOST to choose`);
    host = cores[0].host; port = cores[0].port;
  }
  const info = await coreInfo(host, port);
  target = { host, port, info };
  log(`Roon Core: ${info.name} ${info.version} at ${host}`);
  startOfficial(target);
  return target;
}

function close(reason: string): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // Clear `client` first: closing fires onclosed at once, and that must not read as the Core closing it.
  const c = client; client = null;
  if (c) { try { c.close(); } catch { /* closed */ } log(`connection closed (${reason})`); }
}

async function open(): Promise<RoonClient> {
  if (client) return client;
  const t = await findTarget();
  // The user's consent first: the extension enabled in Roon (see official.ts).
  await paired();
  const c = new RoonClient({ host: t.host, port: INTERNAL_PORT, serverBrokerId: brokerId(t.info.coreId), settleMs: 1500 });
  c.conn.onclosed = () => { try { c.remoting.failPending('broker connection closed'); } catch { /* nothing pending */ } if (client === c) { client = null; log('connection closed by the Core'); } };
  const t0 = Date.now();
  try { await c.connect(); }
  catch (e) { target = null; throw new RoonError(`Can't connect to Roon's internal protocol at ${t.host}:${INTERNAL_PORT} (${(e as Error).message})`, 'unavailable'); }
  client = c;
  log(`connected to the Core in ${Date.now() - t0} ms — ${c.graph.objects.size} objects`);
  if (onFirstConnect) { const f = onFirstConnect; onFirstConnect = null; setTimeout(() => { f().catch(() => {}); }, 0); }
  return c;
}

/** One question to the Core: queued, with the open connection or a new one; then the idle clock starts again. */
export function withCore<T>(work: (c: RoonClient) => Promise<T>): Promise<T> {
  const mine = asked.getStore();
  const task = queue.then(async () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    wanted = mine;
    try { const c = await open(); chooseProfile(c); return await work(c); }
    catch (e) {
      // A question Roon can't answer (an unknown key, a bad argument) leaves the connection fine; anything else may not.
      if (!(e instanceof RoonError && (e.kind === 'not_found' || e.kind === 'invalid'))) close('after an error');
      throw e;
    }
    finally { if (client) idleTimer = setTimeout(() => close('two minutes quiet'), IDLE_MS); }
  });
  queue = task.catch(() => {});
  return task;
}

/** A fresh connection inside withCore (the play history wants a graph without earlier plays). */
export async function fresh(): Promise<RoonClient> {
  close('a fresh graph');
  const c = await open(); chooseProfile(c); return c;
}

/** Close after this question (the history leaves its plays in the graph). */
export function closeSoon(reason: string): void { close(reason); }

export function shutdown(): void { close('shutting down'); }
