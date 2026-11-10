import { describe, expect, it } from 'vitest';
import { registerTrafficTools } from '../../src/tools/traffic.js';
import { payload, rig, text } from '../helpers/harness.js';

/** A history as the router sends it: newest first, `t` a string of uptime seconds. */
function rrd(start: number, step: number, values: number[]) {
  return { data: values.map((v, i) => ({ t: `${String(start - i * step)}.900000`, v })) };
}

const HOSTS = {
  host: [
    { mac: '02:00:00:00:00:01', ip: '192.0.2.5', name: 'tv', active: true, rxbytes: 9000, txbytes: 100 },
    { mac: '02:00:00:00:00:02', ip: '192.0.2.6', name: 'laptop', hostname: 'work-laptop', active: true, rxbytes: 5, txbytes: 5 },
    { mac: '02:00:00:00:00:03', ip: '192.0.2.7', name: 'laptop-old', active: false, rxbytes: 1, txbytes: 1 }
  ]
};
const INTERFACES = { Bridge0: { type: 'Bridge' }, PPPoE0: { type: 'PPPoE', defaultgw: true } };

/** Answers each rrd command in a batch from a per-subject table of speeds. */
function router(speeds: Record<string, { rx: number[]; tx: number[] }>, step = 60) {
  const seen: any[] = [];
  const post = (body: any) => {
    seen.push(body);
    return (body as any[]).map(command => {
      const iface = command.show.interface?.rrd;
      const host = command.show.ip?.hotspot?.rrd;
      const q = iface ?? host;
      const series = speeds[q.name ?? q.mac];
      const data = series ? rrd(1000, step, q.attribute === 'rxspeed' ? series.rx : series.tx) : { data: [] };
      return iface ? { show: { interface: { rrd: data } } } : { show: { ip: { hotspot: { rrd: data } } } };
    });
  };
  return { post, seen };
}

describe('get_traffic', () => {
  const STAT = { rxbytes: 5000, txbytes: 700, rxspeed: 2_000_000, txspeed: 500_000, rxerrors: 0, txerrors: 0, rxdropped: 3, txdropped: 0 };

  function tool(speeds: Record<string, { rx: number[]; tx: number[] }>) {
    const { post, seen } = router(speeds);
    const r = rig(registerTrafficTools, {
      get: path =>
        path === 'show/interface' ? INTERFACES : path === 'show/ip/hotspot' ? HOSTS : path.startsWith('show/interface/stat') ? STAT : {},
      post
    });
    return { call: r.handlers['get_traffic']!, seen, get: r.get };
  }

  it('measures the internet connection over the last hour by default', async () => {
    const { call, seen, get } = tool({ PPPoE0: { rx: [3_000_000, 1_000_000], tx: [400_000, 200_000] } });
    const out = payload(await call({}));
    expect(out).toMatchObject({ interface: 'PPPoE0', period: '1h', stepSeconds: 60, points: 2 });
    expect(out.download).toEqual({ avgKbps: 2000, peakKbps: 3000 });
    expect(out.upload).toEqual({ avgKbps: 300, peakKbps: 400 });
    // detail=1 is the one-minute archive.
    expect(seen[0][0].show.interface.rrd).toEqual({ name: 'PPPoE0', attribute: 'rxspeed', detail: 1 });
    expect(get).toHaveBeenCalledWith('show/interface/stat?name=PPPoE0');
    expect(out.now).toEqual({ downloadKbps: 2000, uploadKbps: 500 });
    expect(out.totals).toMatchObject({ downloadBytes: 5000, rxDropped: 3 });
  });

  it('returns the series oldest first, both directions on one clock', async () => {
    const { call } = tool({ PPPoE0: { rx: [3_000_000, 1_000_000], tx: [400_000, 200_000] } });
    const out = payload(await call({}));
    expect(out.seriesColumns).toEqual(['secondsAgo', 'downloadKbps', 'uploadKbps']);
    expect(out.series).toEqual([
      [60, 1000, 200],
      [0, 3000, 400]
    ]);
  });

  it('maps each period to its archive', async () => {
    const { call, seen } = tool({ Bridge0: { rx: [1], tx: [1] } });
    for (const [period, detail] of [['3min', 0], ['1h', 1], ['3h', 2], ['1d', 3]] as const) {
      await call({ interface: 'Bridge0', period });
      expect(seen.at(-1)[0].show.interface.rrd.detail).toBe(detail);
    }
  });

  it('measures one device, found by part of its name', async () => {
    const { call, seen } = tool({ '02:00:00:00:00:01': { rx: [8_000_000], tx: [100_000] } });
    const out = payload(await call({ device: 'TV', series: false }));
    expect(out).toMatchObject({ device: 'tv', mac: '02:00:00:00:00:01', online: true });
    expect(out.download.peakKbps).toBe(8000);
    expect(out.totals).toEqual({ downloadBytes: 9000, uploadBytes: 100 });
    expect(seen[0][0].show.ip.hotspot.rrd.mac).toBe('02:00:00:00:00:01');
    expect('series' in out).toBe(false);
  });

  it('prefers an exact name over a partial one, and refuses a name that fits several', async () => {
    const { call } = tool({ '02:00:00:00:00:02': { rx: [1000], tx: [1000] } });
    expect(payload(await call({ device: 'laptop' })).mac).toBe('02:00:00:00:00:02');
    const result = await call({ device: 'lap' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/2 devices match/);
  });

  it('refuses interface and device together, and an unknown interface', async () => {
    const { call } = tool({});
    expect((await call({ interface: 'PPPoE0', device: 'tv' })).isError).toBe(true);
    const result = await call({ interface: 'Nope0' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no traffic history/);
  });
});

describe('get_bandwidth_now', () => {
  function tool(speeds: Record<string, { rx: number[]; tx: number[] }>) {
    const { post, seen } = router(speeds, 3);
    const r = rig(registerTrafficTools, { get: { 'show/ip/hotspot': HOSTS }, post });
    return { call: r.handlers['get_bandwidth_now']!, seen };
  }

  it('ranks online devices by what they are moving right now', async () => {
    const { call, seen } = tool({
      '02:00:00:00:00:01': { rx: [100_000, 100_000, 100_000, 100_000, 100_000, 9_000_000], tx: [0, 0, 0, 0, 0, 0] },
      '02:00:00:00:00:02': { rx: [4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000], tx: [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000] }
    });
    const out = payload(await call({}));
    expect(out.devices.map((d: any) => d.name)).toEqual(['laptop', 'tv']);
    expect(out.devices[0]).toMatchObject({ downloadKbps: 4000, uploadKbps: 1000, totalKbps: 5000 });
    // Five 3-second points: the burst six samples back is outside the window.
    expect(out.devices[1].downloadKbps).toBe(100);
    expect(out.windowSeconds).toBe(15);
    expect(out.totalDownloadKbps).toBe(4100);
    // One request, two commands per online device, the offline one not asked about.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(4);
  });

  it('leaves idle devices out of the ranking but counts them', async () => {
    const { call } = tool({ '02:00:00:00:00:01': { rx: [500_000], tx: [0] } });
    const out = payload(await call({}));
    expect(out.devices).toHaveLength(1);
    expect(out).toMatchObject({ onlineDevices: 2, idleDevices: 1 });
  });

  it('widens the window on request', async () => {
    const { call } = tool({ '02:00:00:00:00:01': { rx: [0, 0, 0, 0, 0, 6_000_000], tx: [0, 0, 0, 0, 0, 0] } });
    expect(payload(await call({ window_sec: 18 })).devices[0].downloadKbps).toBe(1000);
  });
});
