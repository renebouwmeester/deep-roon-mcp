import { RoonError } from './errors';
// One rule for picking a zone or output by name (15 Nov 2026): the old lookup fell back to the FIRST substring hit, and
// an empty name matched everything — so "Living Room" (with "Living Room Sonos" and "Living Room Bluesound") or "" could
// send a clear, a transport command or an absolute volume to a zone nobody named. Now: an exact name, or a whole member
// of a group ("A + B"), or a part of a name that fits exactly one; anything else is an error that lists the candidates.
export function pickByName<T>(items: T[], name: string, nameOf: (x: T) => string, what = 'Roon zone'): T | undefined {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) throw new RoonError(`Name a ${what}; Roon has: ${items.map(nameOf).join(', ')}`, 'invalid');
  const lc = (x: T) => nameOf(x).toLowerCase();
  const exact = items.find((x) => lc(x) === want) ?? items.find((x) => lc(x).split(' + ').includes(want));
  if (exact) return exact;
  const part = items.filter((x) => lc(x).includes(want));
  if (part.length > 1) throw new RoonError(`"${name}" fits more than one ${what}: ${part.map(nameOf).join(', ')} — say which`, 'invalid');
  return part[0];
}
