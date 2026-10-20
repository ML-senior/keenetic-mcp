import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerServiceTools } from '../../src/tools/services.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const STATIC_RULES = [
  {
    index: '0',
    interface: 'GigabitEthernet1',
    protocol: 'tcp',
    port: '8123',
    'to-host': '02:00:00:00:00:10'
  },
  {
    index: '1',
    interface: 'GigabitEthernet1',
    protocol: 'tcp',
    port: '554',
    'to-host': '02:00:00:00:00:14',
    disable: true,
    comment: 'camera'
  }
];

const PROXY_TREE = {
  homeassistant: {
    upstream: { proto: 'http', upstream: '192.0.2.10', port: '8123' },
    domain: { ndns: true },
    ssl: { redirect: true },
    'security-level': { public: true }
  }
};

const DNS_HOSTS = [
  { domain: 'nas.home.arpa', address: '192.0.2.10' },
  { domain: 'multi.home.arpa', address: '192.0.2.20' },
  { domain: 'multi.home.arpa', address: '192.0.2.21' }
];

const DHCP_HOSTS = [{ mac: '02:00:00:00:00:10', ip: '192.0.2.10' }];

const RUNNING_CONFIG = [
  '! $$$ some header',
  'access-list _WEBADMIN',
  '  permit tcp 192.0.2.0 0.0.0.255 any',
  '  deny ip any any',
  'ip firewall name-policy',
  'interface Bridge0',
  '  ip access-group _WEBADMIN in',
  ''
].join('\n');

interface Harness {
  handlers: Record<string, Handler>;
  post: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

function harness(readOnly = false): Harness {
  const data: Record<string, unknown> = {
    'ip/static': structuredClone(STATIC_RULES),
    'ip/http/proxy': structuredClone(PROXY_TREE),
    'ip/host': structuredClone(DNS_HOSTS),
    'ip/dhcp/host': structuredClone(DHCP_HOSTS),
    'show/ip/hotspot': { host: [{ mac: '02:00:00:00:00:10', ip: '192.0.2.10', name: 'server-1' }] }
  };
  const get = vi.fn(async (path: string) => {
    if (!(path in data)) throw new Error(`this path does not exist on this firmware: ${path}`);
    return data[path];
  });
  // Simulated router: apply the payload shape the tools send, so readBack sees it.
  const post = vi.fn(async (body: unknown) => {
    const b = body as Record<string, any>;
    if (b.ip?.static) {
      const rule = b.ip.static;
      const list = data['ip/static'] as any[];
      if (rule.no === true) {
        data['ip/static'] = list.filter(r => r.index !== rule.index);
      } else {
        list.push({ ...rule, index: String(list.length) });
      }
    }
    if (b.ip?.http?.proxy) {
      const tree = data['ip/http/proxy'] as Record<string, unknown>;
      for (const [name, entry] of Object.entries(b.ip.http.proxy)) {
        if ((entry as any).no === true) delete tree[name];
        else tree[name] = entry;
      }
    }
    if (b.ip?.host) {
      const rec = b.ip.host;
      const list = data['ip/host'] as any[];
      if (rec.no === true) {
        data['ip/host'] = list.filter(
          h => !(h.domain === rec.domain && h.address === rec.address)
        );
      } else {
        list.push({ domain: rec.domain, address: rec.address });
      }
    }
    if (b.ip?.dhcp?.host) {
      const rec = b.ip.dhcp.host;
      const list = data['ip/dhcp/host'] as any[];
      if (rec.no === true) {
        data['ip/dhcp/host'] = list.filter(h => h.mac !== rec.mac);
      } else {
        const found = list.find(h => h.mac === rec.mac);
        if (found) found.ip = rec.ip;
        else list.push({ mac: rec.mac, ip: rec.ip });
      }
    }
    return {};
  });
  const getText = vi.fn(async (path: string) => {
    if (path === '/ci/running-config.txt') return RUNNING_CONFIG;
    throw new Error(`no such text path: ${path}`);
  });
  const client = { rci: { get, post, getText }, capabilities: vi.fn() } as unknown as KeeneticClient;

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _config: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  registerServiceTools(server, {
    client,
    maxResponseBytes: 25_000,
    readOnly,
    backup: stubBackup()
  } as ToolContext);
  return { handlers, post, data };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('read tools', () => {
  it('get_port_forwarding lists rules with the disabled flag', async () => {
    const out = payload(await harness().handlers['get_port_forwarding']!({}));
    expect(out.total).toBe(2);
    expect(out.rules[0].port).toBe('8123');
    expect(out.rules[1].disabled).toBe(true);
  });

  it('get_port_forwarding names the host behind each MAC', async () => {
    const out = payload(await harness().handlers['get_port_forwarding']!({}));
    const known = out.rules.find((r: { toHost: string }) => r.toHost === '02:00:00:00:00:10');
    if (known) expect(known.target).toMatchObject({ name: 'server-1', ip: '192.0.2.10' });
    expect(out.rules.every((r: { target: unknown }) => 'target' in r)).toBe(true);
  });

  it('get_keendns_mappings warns about public mappings', async () => {
    const out = payload(await harness().handlers['get_keendns_mappings']!({}));
    expect(out.warning).toMatch(/homeassistant.*public/);
  });

  it('get_keendns_mappings flattens the proxy tree', async () => {
    const out = payload(await harness().handlers['get_keendns_mappings']!({}));
    expect(out.mappings).toEqual([
      {
        name: 'homeassistant',
        upstream: '192.0.2.10',
        target: { name: 'server-1', ip: '192.0.2.10', active: false },
        port: '8123',
        proto: 'http',
        sslRedirect: true,
        securityLevel: 'public'
      }
    ]);
  });

  it('get_dns_records returns the ip host tree', async () => {
    const out = payload(await harness().handlers['get_dns_records']!({}));
    expect(out.total).toBe(3);
  });

  it('get_dhcp_static returns reservations', async () => {
    const out = payload(await harness().handlers['get_dhcp_static']!({}));
    expect(out.reservations).toEqual([{ mac: '02:00:00:00:00:10', ip: '192.0.2.10' }]);
  });

  it('get_firewall_rules parses access-lists from the running config', async () => {
    const out = payload(await harness().handlers['get_firewall_rules']!({}));
    expect(out.accessLists).toEqual([
      { name: '_WEBADMIN', rules: ['permit tcp 192.0.2.0 0.0.0.255 any', 'deny ip any any'] }
    ]);
    expect(out.ipFirewall).toEqual(['ip firewall name-policy']);
    expect(out.accessGroups).toEqual(['ip access-group _WEBADMIN in']);
  });

  it('read-only mode hides the write tools', () => {
    const h = harness(true);
    expect(h.handlers['set_port_forwarding']).toBeUndefined();
    expect(h.handlers['remove_keendns_mapping']).toBeUndefined();
    expect(h.handlers['get_port_forwarding']).toBeDefined();
  });
});

describe('set_port_forwarding', () => {
  it('writes a rule targeting a resolved MAC and reports it unsaved', async () => {
    const h = harness();
    const out = payload(
      await h.handlers['set_port_forwarding']!({ to_host: '192.0.2.10', port: 9000 })
    );
    expect(out.saved).toBe(false);
    expect(out.unsavedChanges).toBe(true);
    expect(out.backup).toBe('/tmp/keenetic-test-backup.txt');
    const sent = h.post.mock.calls[0]![0] as any;
    expect(sent.ip.static['to-host']).toBe('02:00:00:00:00:10');
    expect(sent.ip.static.disable).toEqual({ no: true });
  });

  // On a PPPoE line the internet is PPPoE0; a rule on GigabitEthernet1 is
  // accepted and never matches.
  it('listens on the default-route interface when none is named', async () => {
    const h = harness();
    h.data['show/interface'] = {
      GigabitEthernet1: { type: 'GigabitEthernet', defaultgw: false },
      PPPoE0: { type: 'PPPoE', defaultgw: true }
    };
    await h.handlers['set_port_forwarding']!({ to_host: '192.0.2.10', port: 9001 });
    const sent = h.post.mock.calls[0]![0] as any;
    expect(sent.ip.static.interface).toBe('PPPoE0');
  });

  it('refuses an IP the router does not know', async () => {
    const result = await harness().handlers['set_port_forwarding']!({
      to_host: '198.51.100.7',
      port: 9000
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No registered host');
  });
});

describe('remove_port_forwarding', () => {
  it('removes by index and verifies the rule is gone', async () => {
    const h = harness();
    const out = payload(await h.handlers['remove_port_forwarding']!({ index: '0' }));
    expect(out.saved).toBe(false);
    expect((h.data['ip/static'] as any[]).map(r => r.index)).toEqual(['1']);
    const sent = h.post.mock.calls[0]![0] as any;
    expect(sent.ip.static.no).toBe(true);
    expect(sent.ip.static.disable).toBeUndefined();
  });

  it('refuses an ambiguous port match', async () => {
    const h = harness();
    (h.data['ip/static'] as any[]).push({
      index: '2',
      protocol: 'tcp',
      port: '8123',
      'to-host': '02:00:00:00:00:99'
    });
    const result = await h.handlers['remove_port_forwarding']!({ port: 8123 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('narrow it down with index');
  });
});

describe('keendns mappings', () => {
  it('set_keendns_mapping writes the proxy entry', async () => {
    const h = harness();
    const out = payload(
      await h.handlers['set_keendns_mapping']!({ name: 'grafana', host: '192.0.2.10', port: 3000 })
    );
    expect(out.unsavedChanges).toBe(true);
    const sent = h.post.mock.calls[0]![0] as any;
    expect(sent.ip.http.proxy.grafana.upstream).toEqual({
      proto: 'http',
      upstream: '192.0.2.10',
      port: '3000'
    });
  });

  it('remove_keendns_mapping refuses an unknown name', async () => {
    const result = await harness().handlers['remove_keendns_mapping']!({ name: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('remove_keendns_mapping deletes an existing name', async () => {
    const h = harness();
    await h.handlers['remove_keendns_mapping']!({ name: 'homeassistant' });
    expect(h.data['ip/http/proxy']).toEqual({});
  });
});

describe('dns hosts', () => {
  it('set_dns_host adds a new record', async () => {
    const h = harness();
    const out = payload(
      await h.handlers['set_dns_host']!({ domain: 'grafana.home.arpa', address: '192.0.2.30' })
    );
    expect(out.unsavedChanges).toBe(true);
    expect((h.data['ip/host'] as any[]).some(r => r.domain === 'grafana.home.arpa')).toBe(true);
  });

  it('set_dns_host refuses to round-robin an existing name', async () => {
    const result = await harness().handlers['set_dns_host']!({
      domain: 'nas.home.arpa',
      address: '192.0.2.99'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('load-balance');
  });

  it('remove_dns_host requires the address when a name holds several', async () => {
    const result = await harness().handlers['remove_dns_host']!({ domain: 'multi.home.arpa' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('name the address');
  });

  it('remove_dns_host deletes a uniquely identified record', async () => {
    const h = harness();
    await h.handlers['remove_dns_host']!({ domain: 'multi.home.arpa', address: '192.0.2.20' });
    const left = (h.data['ip/host'] as any[]).filter(r => r.domain === 'multi.home.arpa');
    expect(left).toEqual([{ domain: 'multi.home.arpa', address: '192.0.2.21' }]);
  });
});

describe('dhcp reservations', () => {
  it('set_dhcp_host refuses an IP reserved for another MAC', async () => {
    const result = await harness().handlers['set_dhcp_host']!({
      mac: '02:00:00:00:00:77',
      ip: '192.0.2.10'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already reserved');
  });

  it('set_dhcp_host writes a new reservation', async () => {
    const h = harness();
    await h.handlers['set_dhcp_host']!({ mac: '02:00:00:00:00:77', ip: '192.0.2.77' });
    expect(h.data['ip/dhcp/host']).toContainEqual({ mac: '02:00:00:00:00:77', ip: '192.0.2.77' });
  });

  it('remove_dhcp_host deletes the binding', async () => {
    const h = harness();
    await h.handlers['remove_dhcp_host']!({ mac: '02:00:00:00:00:10' });
    expect(h.data['ip/dhcp/host']).toEqual([]);
  });
});
