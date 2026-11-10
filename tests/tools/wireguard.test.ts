import { describe, expect, it } from 'vitest';
import { cliWord } from '../../src/router/cli.js';
import { ValidationError } from '../../src/router/errors.js';
import { cidrToAddressMask, registerWireguardTools } from '../../src/tools/wireguard.js';
import { payload, rig, text } from '../helpers/harness.js';

// Not keys to anything: 32 bytes of a repeated letter, base64-encoded.
const KEY_A = `${'A'.repeat(43)}=`;
const KEY_B = `${'B'.repeat(43)}=`;

describe('cidrToAddressMask', () => {
  it.each([
    ['192.0.2.2/32', '192.0.2.2', '255.255.255.255'],
    ['198.51.100.0/24', '198.51.100.0', '255.255.255.0'],
    ['0.0.0.0/0', '0.0.0.0', '0.0.0.0'],
    ['192.0.2.128/25', '192.0.2.128', '255.255.255.128'],
    ['192.0.2.7', '192.0.2.7', '255.255.255.255']
  ])('converts %s', (cidr, address, mask) => {
    expect(cidrToAddressMask(cidr)).toEqual({ address, mask });
  });

  it.each(['192.0.2.2/33', '999.0.0.1/24', 'fd00::1/64', 'all', '192.0.2.2/x'])('refuses %s', cidr => {
    expect(() => cidrToAddressMask(cidr)).toThrow(ValidationError);
  });
});

describe('cliWord', () => {
  it('passes a plain token', () => {
    expect(cliWord(' vpn.example.net:51820 ', 'endpoint')).toBe('vpn.example.net:51820');
  });

  // Each of these would turn one argument into more of the command line.
  it.each(['a b', 'a\nno interface Bridge0', 'a;b', '', 'a"b', '$(x)', 'a?'])('refuses %j', value => {
    expect(() => cliWord(value, 'comment')).toThrow(ValidationError);
  });
});

/** A router holding one WireGuard interface whose peers the CLI lines edit. */
function router(initial: Array<Record<string, unknown>> = []) {
  let peers = [...initial];
  const lines: string[] = [];
  const post = (body: any) => {
    const line: string = body.parse;
    lines.push(line);
    const add = /^interface Wireguard0 wireguard peer (\S+)$/.exec(line);
    if (add && !peers.some(p => p['key'] === add[1])) peers.push({ key: add[1] });
    const remove = /^interface Wireguard0 no wireguard peer (\S+)$/.exec(line);
    if (remove) peers = peers.filter(p => p['key'] !== remove[1]);
    return { parse: { prompt: '(config)' } };
  };
  const get = (path: string) => {
    if (path === 'show/rc/interface/Wireguard0') return { wireguard: { peer: peers.length === 1 ? peers[0] : peers } };
    if (path === 'show/interface') {
      return {
        Bridge0: { type: 'Bridge' },
        Wireguard0: {
          type: 'Wireguard',
          description: 'office',
          state: 'up',
          link: 'up',
          address: '192.0.2.1',
          wireguard: {
            'public-key': KEY_B,
            'listen-port': 51820,
            peer: [{ 'public-key': KEY_A, remote: '198.51.100.7', 'last-handshake': 12, rxbytes: 10, txbytes: 20, 'preshared-key': 'secret' }]
          }
        }
      };
    }
    throw new Error(`this path does not exist on this firmware: ${path}`);
  };
  return { lines, get, post };
}

describe('list_wireguard_peers', () => {
  it('lists tunnels with their peers and hides secrets', async () => {
    const r = router();
    const out = payload(await rig(registerWireguardTools, r).handlers['list_wireguard_peers']!({}));
    expect(out.total).toBe(1);
    expect(out.tunnels[0]).toMatchObject({ interface: 'Wireguard0', description: 'office', listenPort: 51820, publicKey: KEY_B });
    expect(out.tunnels[0].peers[0]).toMatchObject({ 'public-key': KEY_A, 'last-handshake': 12, 'preshared-key': '<set>' });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('says so when the router has no WireGuard at all', async () => {
    const out = payload(
      await rig(registerWireguardTools, { get: { 'show/interface': { Bridge0: { type: 'Bridge' } } } }).handlers[
        'list_wireguard_peers'
      ]!({})
    );
    expect(out).toMatchObject({ tunnels: [], total: 0 });
    expect(out.note).toMatch(/no WireGuard interfaces/);
  });
});

describe('set_wireguard_peer', () => {
  it('adds a peer, one CLI line per setting, and reads it back', async () => {
    const r = router();
    const rigged = rig(registerWireguardTools, r);
    const out = payload(
      await rigged.handlers['set_wireguard_peer']!({
        interface: 'Wireguard0',
        public_key: KEY_A,
        endpoint: 'vpn.example.net:51820',
        allowed_ips: ['192.0.2.2/32', '198.51.100.0/24'],
        keepalive_sec: 25,
        comment: 'phone'
      })
    );
    const peer = `interface Wireguard0 wireguard peer ${KEY_A}`;
    expect(r.lines).toEqual([
      peer,
      `${peer} endpoint vpn.example.net:51820`,
      `${peer} allow-ips 192.0.2.2 255.255.255.255`,
      `${peer} allow-ips 198.51.100.0 255.255.255.0`,
      `${peer} keepalive-interval 25`,
      `${peer} comment phone`
    ]);
    expect(out.applied).toMatchObject({ interface: 'Wireguard0', action: 'added' });
    expect(out.saved).toBe(false);
    expect(rigged.ctx.backup.ensure).toHaveBeenCalledTimes(1);
  });

  it('reports an existing peer as updated, and never echoes a preshared key', async () => {
    const r = router([{ key: KEY_A, 'preshared-key': 'old-secret' }]);
    const out = payload(
      await rig(registerWireguardTools, r).handlers['set_wireguard_peer']!({
        interface: 'Wireguard0',
        public_key: KEY_A,
        preshared_key: KEY_B,
        keepalive_sec: 0
      })
    );
    expect(out.applied.action).toBe('updated');
    expect(r.lines).toContain(`interface Wireguard0 wireguard peer ${KEY_A} no keepalive-interval`);
    expect(out.peer['preshared-key']).toBe('<set>');
  });

  it('sends nothing when any argument is bad', async () => {
    const cases = [
      { public_key: 'short' },
      { public_key: KEY_A, allowed_ips: ['192.0.2.2/32', 'nonsense'] },
      { public_key: KEY_A, comment: 'two words' },
      { public_key: KEY_A, endpoint: 'host:1 no interface Bridge0' }
    ];
    for (const args of cases) {
      const r = router();
      const result = await rig(registerWireguardTools, r).handlers['set_wireguard_peer']!({ interface: 'Wireguard0', ...args });
      expect(result.isError).toBe(true);
      expect(r.lines).toEqual([]);
    }
  });

  it('refuses an interface that does not exist rather than creating one', async () => {
    const r = router();
    const rigged = rig(registerWireguardTools, r);
    const result = await rigged.handlers['set_wireguard_peer']!({ interface: 'Wireguard7', public_key: KEY_A });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not create one/);
    expect(r.lines).toEqual([]);
    expect(rigged.ctx.backup.ensure).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a WireGuard interface', async () => {
    const r = router();
    const result = await rig(registerWireguardTools, r).handlers['set_wireguard_peer']!({ interface: 'Bridge0', public_key: KEY_A });
    expect(result.isError).toBe(true);
    expect(r.lines).toEqual([]);
  });

  it('fails loudly when the router accepts the lines but the peer is not there', async () => {
    const r = router();
    const result = await rig(registerWireguardTools, { get: r.get, post: () => ({ parse: {} }) }).handlers[
      'set_wireguard_peer'
    ]!({ interface: 'Wireguard0', public_key: KEY_A });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not take effect/);
  });
});

describe('remove_wireguard_peer', () => {
  it('removes the peer and verifies it is gone', async () => {
    const r = router([{ key: KEY_A }, { key: KEY_B }]);
    const out = payload(
      await rig(registerWireguardTools, r).handlers['remove_wireguard_peer']!({ interface: 'Wireguard0', public_key: KEY_A })
    );
    expect(r.lines).toEqual([`interface Wireguard0 no wireguard peer ${KEY_A}`]);
    expect(out.applied.removedPeer).toBe(KEY_A);
  });

  it('refuses a key the interface does not have', async () => {
    const r = router([{ key: KEY_B }]);
    const result = await rig(registerWireguardTools, r).handlers['remove_wireguard_peer']!({ interface: 'Wireguard0', public_key: KEY_A });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no peer with that public key/);
    expect(r.lines).toEqual([]);
  });

  it('is not offered on a read-only server', () => {
    const names = Object.keys(rig(registerWireguardTools, { readOnly: true }).handlers);
    expect(names).toEqual(['list_wireguard_peers']);
  });
});
