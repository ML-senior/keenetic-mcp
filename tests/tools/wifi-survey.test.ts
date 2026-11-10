import { describe, expect, it } from 'vitest';
import { adviseChannel, channelLoads, weightOf, type SurveyCell } from '../../src/shape/channels.js';
import { registerWifiTools } from '../../src/tools/wifi.js';
import { payload, rig, text } from '../helpers/harness.js';

function cell(channel: number, rssi: number, extra: Partial<SurveyCell> = {}): SurveyCell {
  return { ssid: `net-${String(channel)}`, bssid: '02:00:00:00:00:99', channel, occupied: [], widthMhz: 20, rssi, own: false, ...extra };
}

describe('channelLoads', () => {
  it('weighs a loud neighbour above a faint one', () => {
    expect(weightOf(-50)).toBeGreaterThan(weightOf(-88));
    expect(weightOf(-99)).toBe(0);
  });

  it('charges a 2.4 GHz network to the channels either side of it', () => {
    const loads = channelLoads([cell(6, -60)], '2.4GHz');
    const score = (c: number) => loads.find(l => l.channel === c)!.score;
    expect(score(6)).toBeGreaterThan(score(4));
    expect(score(4)).toBeGreaterThan(0);
    expect(score(1)).toBe(0);
    expect(score(11)).toBe(0);
  });

  it('charges a 40 MHz network to everything it spans', () => {
    // As the router reports a 40 MHz network on channel 1: seven channels wide.
    const loads = channelLoads([cell(1, -70, { occupied: [1, 2, 3, 4, 5, 6, 7], widthMhz: 40 })], '2.4GHz');
    expect(loads.find(l => l.channel === 6)!.networks).toBe(1);
    expect(loads.find(l => l.channel === 11)!.networks).toBe(0);
  });

  it('ignores this router\'s own networks and the other band', () => {
    const loads = channelLoads([cell(6, -40, { own: true }), cell(36, -40)], '2.4GHz');
    expect(loads.every(l => l.score === 0)).toBe(true);
  });

  it('flags DFS channels at 5 GHz', () => {
    const loads = channelLoads([], '5GHz');
    expect(loads.find(l => l.channel === 36)!.dfs).toBeUndefined();
    expect(loads.find(l => l.channel === 100)!.dfs).toBe(true);
  });
});

describe('adviseChannel', () => {
  it('picks the quietest of 1, 6 and 11', () => {
    const loads = channelLoads([cell(1, -45), cell(1, -50), cell(6, -55)], '2.4GHz');
    const advice = adviseChannel(loads, '2.4GHz', 1)!;
    expect(advice.recommended).toBe(11);
    expect(advice.keepCurrent).toBe(false);
    expect(advice.reason).toMatch(/channel 11/);
  });

  it('says to stay when the current channel is already the quietest', () => {
    const loads = channelLoads([cell(1, -50), cell(6, -50)], '2.4GHz');
    expect(adviseChannel(loads, '2.4GHz', 11)).toMatchObject({ recommended: 11, keepCurrent: true });
  });

  it('does not send every client through a reconnect for a marginal gain', () => {
    const loads = channelLoads([cell(1, -88), cell(6, -90)], '2.4GHz');
    expect(adviseChannel(loads, '2.4GHz', 1)!.keepCurrent).toBe(true);
  });

  it('points out a radio parked between the non-overlapping channels', () => {
    const loads = channelLoads([cell(1, -40), cell(6, -40)], '2.4GHz');
    expect(adviseChannel(loads, '2.4GHz', 3)!.reason).toMatch(/between the non-overlapping/);
  });

  it('prefers a non-DFS block over a DFS one that is only slightly quieter', () => {
    const loads = channelLoads([cell(36, -90, { occupied: [36] })], '5GHz');
    // 36-48 scores 5; every DFS block scores 0 but carries the radar penalty.
    expect(adviseChannel(loads, '5GHz', null)!.recommended).toBe(149);
    const crowded = channelLoads(
      [149, 153, 157, 161, 36, 40, 44, 48].map(c => cell(c, -45, { occupied: [c] })),
      '5GHz'
    );
    expect(adviseChannel(crowded, '5GHz', 36)).toMatchObject({ recommended: 52, keepCurrent: false });
  });
});

describe('get_wifi_survey', () => {
  const INTERFACES = {
    WifiMaster0: { type: 'WifiMaster', channel: 1, bandwidth: '20' },
    'WifiMaster0/AccessPoint0': { type: 'AccessPoint', ssid: 'ssid-home' },
    WifiMaster1: { type: 'WifiMaster', channel: 36, bandwidth: '80' },
    'WifiMaster1/AccessPoint0': { type: 'AccessPoint', ssid: 'ssid-home' },
    Bridge0: { type: 'Bridge' }
  };
  const SURVEY: Record<string, unknown[]> = {
    WifiMaster0: [
      { address: '02:00:00:00:00:a1', essid: 'neighbour-loud', channel: 1, 'busy-channels': [1], bandwidth: '20', rssi: -48 },
      { address: '02:00:00:00:00:a2', essid: 'neighbour-far', channel: 6, 'busy-channels': [6], bandwidth: '20', rssi: -85 },
      { address: '02:00:00:00:00:a3', essid: 'ssid-home', channel: 1, 'busy-channels': [1], bandwidth: '20', rssi: -40 },
      { address: '02:00:00:00:00:a4', essid: '', channel: 1, bandwidth: '20', rssi: -60 },
      { address: '02:00:00:00:00:a5', essid: 'broken-record' }
    ],
    WifiMaster1: []
  };
  const post = (body: any) => ({ show: { 'site-survey': { ap_cell: SURVEY[body.show['site-survey'].name] } } });
  const tool = () => rig(registerWifiTools, { get: { 'show/interface': INTERFACES }, post }).handlers['get_wifi_survey']!;

  // A survey takes the radio off its channel and can drop its clients, so
  // it is never what happens by default.
  it('lists the radios and surveys nothing when no radio is named', async () => {
    const r = rig(registerWifiTools, { get: { 'show/interface': INTERFACES }, post });
    const out = payload(await r.handlers['get_wifi_survey']!({}));
    expect(out.radios.map((x: any) => x.radio)).toEqual(['WifiMaster0', 'WifiMaster1']);
    expect(out.radios[0]).toMatchObject({ channel: 1, ssids: ['ssid-home'] });
    expect(out.note).toMatch(/Nothing was surveyed/);
    expect(r.post).not.toHaveBeenCalled();
  });

  it('surveys only the radio it was asked for', async () => {
    const r = rig(registerWifiTools, { get: { 'show/interface': INTERFACES }, post });
    await r.handlers['get_wifi_survey']!({ radio: 'WifiMaster0' });
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(r.post).toHaveBeenCalledWith({ show: { 'site-survey': { name: 'WifiMaster0' } } });
  });

  it('reports the radio with its neighbours and a recommendation', async () => {
    const out = payload(await tool()({ radio: 'WifiMaster0' }));
    expect(out.radios.map((r: any) => r.radio)).toEqual(['WifiMaster0']);
    const radio = out.radios[0];
    expect(radio).toMatchObject({ band: '2.4GHz', channel: 1, networksHeard: 3, ownNetworksHeard: 1 });
    expect(radio.advice).toMatchObject({ recommended: 11, keepCurrent: false });
  });

  it('does not count the router\'s own Mesh nodes as neighbours', async () => {
    const radio = payload(await tool()({ radio: 'wifimaster0' })).radios[0];
    expect(radio.strongestNeighbours.map((n: any) => n.ssid)).toEqual([
      'neighbour-loud',
      '(hidden)',
      'neighbour-far'
    ]);
  });

  it('copes with a radio that hears nothing', async () => {
    const radio = payload(await tool()({ radio: 'WifiMaster1' })).radios[0];
    expect(radio).toMatchObject({ band: '5GHz', networksHeard: 0 });
    expect(radio.advice.keepCurrent).toBe(true);
  });

  it('names the radios when asked for one that does not exist', async () => {
    const result = await tool()({ radio: 'WifiMaster9' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('WifiMaster0, WifiMaster1');
  });

  it('reports a failed survey as such', async () => {
    const r = rig(registerWifiTools, {
      get: { 'show/interface': INTERFACES },
      post: () => {
        throw new Error('radio is busy');
      }
    });
    const out = payload(await r.handlers['get_wifi_survey']!({ radio: 'WifiMaster0' }));
    expect(out.radios[0]).toMatchObject({ radio: 'WifiMaster0', error: 'radio is busy' });
  });
});
