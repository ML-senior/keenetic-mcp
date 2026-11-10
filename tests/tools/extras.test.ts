import { describe, expect, it } from 'vitest';
import { registerDeviceTools } from '../../src/tools/devices.js';
import { registerNetworkTools } from '../../src/tools/network.js';
import { payload, rig, text } from '../helpers/harness.js';

describe('list_schedules', () => {
  // The shape of `show schedule` on KeeneticOS 5.2: alternating start and stop
  // events in week order, each with the seconds left until it fires.
  const SCHEDULES = {
    schedule: {
      night: {
        description: 'no internet at night',
        action: [
          { type: 'start', left: 3600, dow: 'Sun', time: '01:00' },
          { type: 'stop', left: 21600, dow: 'Sun', time: '06:00' },
          { type: 'start', left: 90000, dow: 'Mon', time: '23:00' },
          { type: 'stop', left: 108000, dow: 'Tue', time: '06:00' }
        ]
      },
      running: {
        action: [
          { type: 'stop', left: 600, dow: 'Sat', time: '18:00' },
          { type: 'start', left: 80000, dow: 'Sun', time: '09:00' }
        ]
      }
    }
  };
  const tool = (raw: unknown) => rig(registerNetworkTools, { get: { 'show/schedule': raw } }).handlers['list_schedules']!;

  it('pairs each start with the stop that follows it', async () => {
    const out = payload(await tool(SCHEDULES)({}));
    expect(out.total).toBe(2);
    expect(out.schedules[0]).toMatchObject({
      name: 'night',
      description: 'no internet at night',
      intervals: ['Sun 01:00-06:00', 'Mon 23:00 - Tue 06:00']
    });
  });

  it('tells whether a schedule is on right now from its next event', async () => {
    const out = payload(await tool(SCHEDULES)({}));
    expect(out.schedules[0]).toMatchObject({ activeNow: false, nextChange: 'start in 3600 s' });
    expect(out.schedules[1]).toMatchObject({ activeNow: true, nextChange: 'stop in 600 s' });
  });

  it('reads the unwrapped form and an empty router', async () => {
    expect(payload(await tool(SCHEDULES.schedule)({})).total).toBe(2);
    expect(payload(await tool({})({}))).toEqual({ schedules: [], total: 0 });
  });
});

describe('wake_device', () => {
  const HOSTS = { host: [{ mac: '02:00:00:00:00:01', name: 'nas', active: false }] };
  const setup = () => {
    const lines: string[] = [];
    const r = rig(registerDeviceTools, {
      get: { 'show/ip/hotspot': HOSTS },
      post: (body: any) => {
        lines.push(body.parse);
        return { parse: { prompt: '(config)' } };
      }
    });
    return { call: r.handlers['wake_device']!, lines, ctx: r.ctx };
  };

  it('has the router send the magic packet', async () => {
    const { call, lines, ctx } = setup();
    const out = payload(await call({ mac: '02-00-00-00-00-01' }));
    expect(lines).toEqual(['ip hotspot wake 02:00:00:00:00:01']);
    expect(out).toMatchObject({ sent: true, device: 'nas', wasOnline: false });
    // Nothing in the configuration changes, so there is nothing to back up.
    expect(ctx.backup.ensure).not.toHaveBeenCalled();
  });

  it('warns when the router does not know the address', async () => {
    const { call } = setup();
    const out = payload(await call({ mac: '02:00:00:00:00:77' }));
    expect(out.device).toBeNull();
    expect(out.note).toMatch(/does not know this MAC/);
  });

  it('refuses something that is not a MAC', async () => {
    const { call, lines } = setup();
    const result = await call({ mac: 'nas; system reboot' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not a MAC address/);
    expect(lines).toEqual([]);
  });
});
