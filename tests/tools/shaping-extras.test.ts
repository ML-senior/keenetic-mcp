import { describe, expect, it } from 'vitest';
import { bandOf } from '../../src/tools/network.js';
import { projectInterface } from '../../src/shape/project.js';

describe('bandOf', () => {
  // Captured from a KN-1810 on 5.2: no `band` field, only the channel.
  it('reads the band from the channel when the firmware gives none', () => {
    expect(bandOf({ type: 'WifiMaster' }, 36)).toBe('5GHz');
    expect(bandOf({ type: 'WifiMaster' }, 6)).toBe('2.4GHz');
    expect(bandOf({ type: 'WifiMaster' }, null)).toBe('unknown');
  });

  it('trusts a band the firmware does report', () => {
    expect(bandOf({ band: '6GHz' }, 37)).toBe('6GHz');
  });
});

describe('projectInterface for ports', () => {
  it('names the WAN port and fills state from the link', () => {
    const out = projectInterface('0', {
      id: 'GigabitEthernet1/0',
      label: '0',
      type: 'Port',
      link: 'up',
      speed: '1000',
      duplex: 'full'
    });
    expect(out).toMatchObject({
      state: 'up',
      description: 'WAN port',
      port: { rciName: 'GigabitEthernet1/0', role: 'wan', speedMbps: 1000, duplex: 'full' }
    });
  });

  it('labels LAN ports by their front-panel number', () => {
    const out = projectInterface('3', { id: 'GigabitEthernet0/2', label: '3', type: 'Port', link: 'down' });
    expect(out).toMatchObject({ state: 'down', description: 'LAN port 3', port: { role: 'lan', speedMbps: null } });
  });

  it('leaves other interfaces alone', () => {
    expect(projectInterface('Bridge0', { type: 'Bridge', state: 'up' }).port).toBeUndefined();
  });
});
