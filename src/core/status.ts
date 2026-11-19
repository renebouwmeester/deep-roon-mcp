// How Deep Roon MCP stands: the Core, the pairing, the internal protocol, a self-test of a few reads, and whether
// there's a newer version. The self-test runs once, at the first connection; a failure names the tools it affects —
// Roon's internal protocol can change with any Roon update, and then the user should hear which tools broke, not get a
// stack trace from each.
import { version } from '../../package.json';
import { log } from './log';

export interface Check { name: string; ok: boolean; ms: number; detail?: string; affects: string }
let checks: Check[] | null = null;
let checking: Promise<void> | null = null;

/** Runs the self-test once (the caller passes the reads to try). */
export function selfTest(run: () => Promise<Check[]>): Promise<void> {
  checking ??= run().then((c) => {
    checks = c;
    const bad = c.filter((x) => !x.ok);
    log(bad.length ? `self-test: ${bad.map((x) => `${x.name} failed (${x.detail})`).join('; ')}` : `self-test: ${c.length} reads ok`);
  }).catch((e) => { log(`self-test couldn't run: ${(e as Error).message}`); });
  return checking;
}
export const selfTestResults = (): Check[] | null => checks;
/** Forget the self-test (a Core update can break the internal protocol): it runs again at the next roon_status. */
export function resetSelfTest(): void { checks = null; checking = null; }

// ---- a newer version on GitHub ----
let newer: { version: string; url: string } | null = null;
let told = false;
const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
const isNewer = (a: string, b: string) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); } return false; };

/** Looks once, at the start, for a newer release on GitHub (no account, no data sent beyond the request itself). */
export async function checkForUpdate(): Promise<void> {
  if (process.env.DEEP_ROON_NO_UPDATE_CHECK === '1') return;
  try {
    const r = await fetch('https://api.github.com/repos/renebouwmeester/deep-roon-mcp/releases/latest', {
      headers: { 'User-Agent': `deep-roon-mcp/${version}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const j = await r.json() as { tag_name?: string; html_url?: string };
    if (j.tag_name && isNewer(j.tag_name, version)) { newer = { version: j.tag_name.replace(/^v/, ''), url: j.html_url ?? '' }; log(`a newer version is out: ${newer.version}`); }
  } catch { /* offline, rate-limited: nothing to say */ }
}
export const updateInfo = () => newer;
/** The line for the first answer after a newer version was found — once per run. */
export function updateNotice(): string | null {
  if (!newer || told) return null;
  told = true;
  return `Deep Roon MCP ${newer.version} is available (this is ${version}): ${newer.url}`;
}
