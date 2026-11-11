// Roon's audio devices as Settings → Audio shows them (RAAT servers and their devices), and the reset for a device that
// stays on "Enabling…".
//
// Why (11 Nov 2026, a phone as RAAT zone over Tailscale): when a phone's Roon app restarts or changes networks, the Core's
// RAAT client gets "Connection refused" and backs off — 0.5 s, 0.75 s … 19 s and longer. The device then hangs on "Enabling…"
// although the phone is reachable again; disable + enable in Settings → Audio connects at once. This does the same, for a
// device that is enabled and online but has no zone.
import { withCore, RoonError } from '../core/session';
import { Any, C, field, flag, items, obj, short, untilField, untilLoaded, wait } from './graph';

type Device = { name: string; server: string; ip: string; enabled: boolean; zone: boolean; status: string; oid: bigint };

async function raatDevices(c: C): Promise<Device[]> {
  const list = await untilField(c, c.serviceOid('Transport'), 'RaatServers', 4000);
  const servers = items(c, list);
  const out: Device[] = [];
  for (const s of servers) {
    const devs = field(s, 'Devices') ?? (await untilField(c, s.oid, 'Devices', 2000));
    const refs = obj(c, devs)?.fields?.$items ?? [];
    await untilLoaded(c, refs, 2000);
    for (const d of items(c, devs)) {
      const name = field(d, 'Name');
      if (typeof name !== 'string') continue;
      // The device's own endpoint, and that endpoint's zone (not by name: a zone can be renamed, "BlackHole 2ch" → "Blackhole").
      const ep = obj(c, field(d, 'Endpoint'));
      const zone = !!ep && obj(c, field(ep, 'Zone')) != null;
      out.push({ name, server: String(field(s, 'MachineName') ?? ''), ip: String(field(s, 'IPAddress') ?? ''),
                 enabled: flag(field(d, 'IsEnabled')), zone, status: String(field(d, 'Status') ?? ''), oid: BigInt(d.oid) });
    }
  }
  return out;
}

const show = (d: Device) => ({ name: d.name, machine: d.server, ip: d.ip, enabled: d.enabled, zone: d.zone, ...(d.status ? { status: d.status } : {}) });

/** RAAT devices with their state: enabled, and whether they have a zone now. */
export async function devices() {
  return withCore(async (c) => ({ devices: (await raatDevices(c)).map(show) }));
}

/** Disable + enable the RAAT devices that are enabled but have no zone — only those, filtered by name or by the address of
 *  their RAAT server. Reads back after a few seconds. */
export async function deviceReset(opts: { name?: string; ip?: string }) {
  if (!opts.name && !opts.ip) throw new RoonError('Give a device name or the address of its RAAT server', 'invalid');
  return withCore(async (c) => {
    const want = opts.name?.toLowerCase();
    const all = await raatDevices(c);
    const match = all.filter((d) => (!want || d.name.toLowerCase() === want) && (!opts.ip || d.ip === opts.ip));
    if (!match.length) throw new RoonError(`No RAAT device ${opts.name ?? ''}${opts.ip ? ' at ' + opts.ip : ''}; Roon has: ${all.map((d) => d.name).join(', ')}`, 'not_found');
    const stuck = match.filter((d) => d.enabled && !d.zone);
    const done: string[] = [];
    for (const d of stuck) {
      await short(c.call('RaatServerAudioDevice', 'Disable', [{ type: 'ResultCallback', name: 'cb_result' }], Buffer.alloc(0), d.oid), 6000);
      await wait(800);
      await short(c.call('RaatServerAudioDevice', 'Enable', [{ type: 'ResultCallback<Endpoint>', name: 'cb_result' }], Buffer.alloc(0), d.oid), 8000);
      done.push(d.name);
    }
    if (done.length) await wait(3000);
    const after = (await raatDevices(c)).filter((d) => match.some((m) => m.oid === d.oid)).map(show);
    return { reset: done, left_alone: match.filter((d) => !stuck.includes(d)).map((d) => `${d.name} (${d.enabled ? 'has a zone' : 'disabled'})`), now: after };
  });
}
