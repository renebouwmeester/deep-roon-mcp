// Roon's storage locations (Sooloos.Broker.Api.Location): each watched folder of the Core, and the TIDAL/Qobuz libraries.
// A local folder's Name is a number; DisplayName is what Roon shows (Settings › Storage, Focus) — measured 21 Nov 2026.
export interface LocationInfo { ref: bigint; name: string; displayName: string; category: number }

const LOCAL = 100;
const streaming = (l: LocationInfo): string => (/tidal/i.test(`${l.name} ${l.displayName}`) ? 'tidal' : /qobuz/i.test(`${l.name} ${l.displayName}`) ? 'qobuz' : '');

/** The locations a `storage` value means: "local" = every local folder, "tidal"/"qobuz" = that library, else the location
 *  whose shown name is exactly this (case ignored). */
export function chooseLocations(locs: LocationInfo[], wanted: string): bigint[] {
  const want = wanted.trim().toLowerCase();
  if (want === 'local') return locs.filter((l) => l.category === LOCAL || (!streaming(l) && l.category !== 400)).map((l) => l.ref);
  if (want === 'tidal' || want === 'qobuz') return locs.filter((l) => streaming(l) === want).map((l) => l.ref);
  return locs.filter((l) => l.displayName.trim().toLowerCase() === want).map((l) => l.ref);
}

/** How Focus names a location: TIDAL and Qobuz by their service (as before, not Roon's "TIDAL Library" / "qobuz Library"),
 *  a local folder by the name Roon shows for it, else "Local". */
export function locationName(l: LocationInfo): string {
  const kind = streaming(l);
  if (kind) return kind === 'tidal' ? 'TIDAL' : 'Qobuz';
  return l.displayName.trim() || 'Local';
}
