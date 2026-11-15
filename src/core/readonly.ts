// DEEP_ROON_READ_ONLY, read in one place (15 Nov 2026): index.ts and the playlist editor parsed it with opposite rules,
// and index.ts failed open — "on", "enabled" or "y" meant every write tool. Now: empty/off/0/false/no = off, "all" = all,
// anything else = read-only library. When in doubt, closed.
export type ReadOnly = 'off' | 'library' | 'all';
export function readOnlyMode(raw = process.env.DEEP_ROON_READ_ONLY): ReadOnly {
  const ro = (raw ?? '').trim().toLowerCase();
  if (!ro || ['off', '0', 'false', 'no'].includes(ro)) return 'off';
  return ro === 'all' ? 'all' : 'library';
}
