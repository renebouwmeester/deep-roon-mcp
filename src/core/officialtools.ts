// With the internal protocol switched off (DEEP_ROON_INTERNAL=off): what the official extension API alone can do —
// zones, what plays, the buttons, seek, volume, shuffle / repeat / Roon Radio, transfer, grouping, standby, the cover.
// The same tool names as with the internal protocol, so a client sees nothing change but the number of tools.
import { RoonError, Target } from './errors';
import { officialReady, officialZone, officialZones, paired, OfficialZone } from './official';
import { pickByName } from './namematch';

const call = (fn: (cb: (err: unknown) => void) => void) => new Promise<void>((res, rej) => fn((err) => (err ? rej(new RoonError(`Roon refused: ${err}`)) : res())));
const duration = (s: number) => { const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function zoneOf(name: string): Promise<{ t: any; z: OfficialZone }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = await paired();
  await officialReady();
  const z = officialZone(name);
  if (!z) throw new RoonError(`No Roon zone called "${name}"; Roon has: ${officialZones().map((x) => x.display_name).join(', ')}`, 'not_found');
  return { t, z };
}

export async function zones() {
  await officialReady();
  const all = officialZones();
  return { zones: [...new Set(all.flatMap((z) => z.outputs.map((o) => o.display_name)))].sort(),
           groups: all.filter((z) => z.outputs.length > 1).map((z) => z.outputs.map((o) => o.display_name)) };
}

export async function nowPlaying() {
  await officialReady();
  return { zones: officialZones().map((z: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r: any = { zone: z.display_name, state: z.state }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const v = z.outputs.find((o: any) => o.volume)?.volume; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (v) { r.volume = v.value; r.volume_max = v.max; if (v.is_muted) r.muted = true; }
    if (z.settings?.shuffle) r.shuffle = true;
    if (z.settings?.loop && z.settings.loop !== 'disabled') r.repeat = z.settings.loop === 'loop_one' ? 'one' : 'all';
    if (z.settings?.auto_radio) r.roon_radio = true;
    const np = z.now_playing;
    if (np && z.state !== 'stopped') {
      if (np.three_line?.line1) { r.title = np.three_line.line1; if (np.three_line.line2) r.artist = np.three_line.line2; if (np.three_line.line3) r.album = np.three_line.line3; }
      if (typeof np.seek_position === 'number') r.position = duration(np.seek_position);
      if (typeof np.length === 'number') r.length = duration(np.length);
    }
    return r;
  }) };
}

export async function control(name: string, action: string) {
  const { t, z } = await zoneOf(name);
  await call((cb) => t.control(z.zone_id, action, cb));
  const expect: Record<string, string[]> = { pause: ['paused'], stop: ['stopped', 'paused'], play: ['playing', 'loading'] };
  let state = officialZone(z.display_name)?.state;
  if (expect[action]) { const end = Date.now() + 3000; while (Date.now() < end && !expect[action].includes(state ?? '')) { await wait(150); state = officialZone(z.display_name)?.state; } }
  return { ok: !expect[action] || expect[action].includes(state ?? ''), zone: z.display_name, action, state };
}
export async function seek(name: string, seconds: number) {
  const { t, z } = await zoneOf(name);
  await call((cb) => t.seek(z.zone_id, 'absolute', Math.max(0, Math.round(seconds)), cb));
  return { ok: true, zone: z.display_name, position: duration(seconds) };
}
export async function settings(name: string, s: { shuffle?: boolean; repeat?: 'off' | 'all' | 'one'; roon_radio?: boolean | 'now' }) {
  if (s.roon_radio === 'now') throw new RoonError('"Start Roon Radio now" needs the internal protocol (switched off)', 'invalid');
  const { t, z } = await zoneOf(name);
  const change: Record<string, unknown> = {};
  if (s.shuffle !== undefined) change.shuffle = s.shuffle;
  if (s.repeat !== undefined) change.loop = { off: 'disabled', all: 'loop', one: 'loop_one' }[s.repeat];
  if (s.roon_radio !== undefined) change.auto_radio = s.roon_radio;
  if (!Object.keys(change).length) throw new RoonError('Nothing to set: give shuffle, repeat or roon_radio', 'invalid');
  await call((cb) => t.change_settings(z.zone_id, change, cb));
  return { ok: true, zone: z.display_name, ...s };
}
export async function transfer(from: string, to: string) {
  const a = await zoneOf(from), b = await zoneOf(to);
  if (a.z.zone_id === b.z.zone_id) throw new RoonError('From and to are the same zone', 'invalid');
  await call((cb) => a.t.transfer_zone(a.z.zone_id, b.z.zone_id, cb));
  return { ok: true, from: a.z.display_name, to: b.z.display_name };
}
export async function group(main: string, join: string[]) {
  const m = await zoneOf(main);
  const outs = [...m.z.outputs.map((o) => o.output_id)];
  for (const n of join) { const j = await zoneOf(n); for (const o of j.z.outputs) if (!outs.includes(o.output_id)) outs.push(o.output_id); }
  if (outs.length === m.z.outputs.length) throw new RoonError('Nothing to group: name at least one other zone', 'invalid');
  await call((cb) => m.t.group_outputs(outs, cb));
  return { ok: true, group: outs.map((id) => officialZones().flatMap((z) => z.outputs).find((o) => o.output_id === id)?.display_name ?? id) };
}
export async function ungroup(name: string, only?: string) {
  const { t, z } = await zoneOf(name);
  if (z.outputs.length < 2) throw new RoonError(`${z.display_name} isn't in a group`, 'invalid');
  const een = only ? pickByName(z.outputs, only, (o) => o.display_name, 'output in this group') : undefined;
  const off = only ? (een ? [een] : []) : z.outputs;
  if (!off.length) throw new RoonError(`"${only}" isn't in this group`, 'not_found');
  await call((cb) => t.ungroup_outputs(off.map((o) => o.output_id), cb));
  return { ok: true, released: off.map((o) => o.display_name) };
}
export async function standby(name: string, on: boolean) {
  const { t, z } = await zoneOf(name);
  for (const o of z.outputs) await call((cb) => (on ? t.standby(o.output_id, {}, cb) : t.convenience_switch(o.output_id, {}, cb)));
  return { ok: true, zone: z.display_name, standby: on };
}
export async function cover(target: Target, name?: string) {
  await officialReady();
  const z = name ? officialZone(name) : officialZones().find((x) => x.state === 'playing' && x.now_playing?.image_key) ?? officialZones().find((x) => x.state === 'paused' && x.now_playing?.image_key);
  if (!z) throw new RoonError(name ? `No Roon zone called "${name}"` : 'Nothing plays in Roon right now', 'not_found');
  const key = z.now_playing?.image_key;
  if (!key) throw new RoonError(`Roon has no cover for what plays on ${z.display_name}`, 'not_found');
  const r = await fetch(`http://${target.host}:${target.port}/api/image/${key}?scale=fit&width=600&height=600`).catch(() => null);
  if (!r?.ok) throw new RoonError('Roon doesn\'t hand over the cover right now', 'unavailable');
  const l = z.now_playing?.three_line;
  return { info: { zone: z.display_name, title: l?.line1, artist: l?.line2, album: l?.line3 },
           image: { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: r.headers.get('content-type') ?? 'image/jpeg' } };
}
