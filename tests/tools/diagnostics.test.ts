import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerDiagnosticsTools } from '../../src/tools/diagnostics.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const LOG_TEXT = [
  'Jul 24 08:00:01 ndm: system started',
  'Jul 24 08:00:05 ndhcps: DHCPDISCOVER from 02:00:00:00:00:10',
  'Jul 24 08:00:06 wan: connection up'
].join('\n');

const DATA: Record<string, unknown> = {
  'show/ip/hotspot': {
    host: [
      { mac: '02:00:00:00:00:01', active: true, name: 'laptop-1' },
      {
        mac: '02:00:00:00:00:02',
        active: true,
        name: 'laptop-2',
        'mws-backhaul': true
      },
      {
        'system-mode': 'extender',
        active: true,
        name: 'extender-hall',
        description: 'KN-1011',
        firmware: '5.1.5',
        ip: '192.0.2.2',
        mac: '02:00:00:00:00:e1',
        speed: 866,
        uptime: 3600
      }
    ]
  },
  'show/version': { description: 'ctrl-1', hw_id: 'KN-1010', release: '5.1.5' },
  'show/ping-check': { profile: [{ name: 'default', status: 'ok' }] },
  'show/media': {
    'usb-0': {
      bus: 'usb',
      product: ' Flash Drive ',
      state: 'ready',
      partition: {
        'uuid-1': {
          uuid: 'uuid-1',
          label: 'entware',
          fstype: 'ext4',
          state: 'mounted',
          total: 16_106_127_360,
          free: 8_589_934_592,
          'used-by': ['opkg']
        }
      }
    }
  },
  opkg: { disk: 'uuid-1', initrc: '/opt/etc/initrc' },
  'show/last-change': {
    date: 'Thu, 01 Jan 2026 00:00:00 GMT',
    user: 'admin',
    agent: 'http/rci',
    checksum: 'aaa',
    'fail-safe': { unsaved: false, rollback: false, 'time-left': 0 }
  }
};

const SAVED_CONFIG = '! $$$ Md5 checksum: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';

interface Harness {
  handlers: Record<string, Handler>;
  post: ReturnType<typeof vi.fn>;
}

function harness(readOnly = false): Harness {
  const get = vi.fn(async (path: string) => {
    if (!(path in DATA)) throw new Error(`this path does not exist on this firmware: ${path}`);
    return DATA[path];
  });
  const post = vi.fn(async () => ({}));
  const getText = vi.fn(async (path: string) => {
    if (path === '/ci/log') return LOG_TEXT;
    if (path === '/ci/startup-config.txt') return SAVED_CONFIG;
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

  registerDiagnosticsTools(server, {
    client,
    maxResponseBytes: 25_000,
    readOnly,
    backup: stubBackup()
  } as ToolContext);
  return { handlers, post };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('get_log', () => {
  it('tails the log and counts totals', async () => {
    const out = payload(await harness().handlers['get_log']!({ lines: 2 }));
    expect(out.shown).toBe(2);
    expect(out.total).toBe(3);
    expect(out.log).toContain('connection up');
    expect(out.log).not.toContain('system started');
  });

  it('filters case-insensitively', async () => {
    const out = payload(await harness().handlers['get_log']!({ filter: 'dhcp' }));
    expect(out.total).toBe(1);
    expect(out.log).toContain('DHCPDISCOVER');
  });
});

describe('run_ping', () => {
  it('rejects option-shaped hosts before touching the shell', async () => {
    const result = await harness().handlers['run_ping']!({ host: '-evil' });
    expect(result.isError).toBe(true);
  });

  it('rejects whitespace and shell metacharacters', async () => {
    for (const host of ['a b', 'x;rm', '$(id)']) {
      const result = await harness().handlers['run_ping']!({ host });
      expect(result.isError).toBe(true);
    }
  });
});

describe('get_mesh_nodes', () => {
  it('lists the controller and extenders with client counts', async () => {
    const out = payload(await harness().handlers['get_mesh_nodes']!({}));
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[0]).toMatchObject({ role: 'controller', model: 'KN-1010', activeClients: 1 });
    expect(out.nodes[1]).toMatchObject({
      role: 'extender',
      name: 'extender-hall',
      connectionSpeedMbps: 866,
      activeClients: 1
    });
    expect(out.totalActiveClients).toBe(2);
  });
});

describe('get_media', () => {
  it('flattens partitions with sizes in MB', async () => {
    const out = payload(await harness().handlers['get_media']!({}));
    expect(out.partitions).toHaveLength(1);
    expect(out.partitions[0]).toMatchObject({
      media: 'usb-0',
      label: 'entware',
      fstype: 'ext4',
      totalMb: 15360,
      usedBy: ['opkg']
    });
  });
});

describe('get_opkg_status', () => {
  it('returns the opkg config tree', async () => {
    const out = payload(await harness().handlers['get_opkg_status']!({}));
    expect(out.opkg).toEqual({ disk: 'uuid-1', initrc: '/opt/etc/initrc' });
  });
});

describe('reboot_router', () => {
  it('is hidden in read-only mode', () => {
    expect(harness(true).handlers['reboot_router']).toBeUndefined();
  });

  it('posts the reboot command and reports pending unsaved changes', async () => {
    const h = harness();
    const out = payload(await h.handlers['reboot_router']!({ confirm: true }));
    expect(h.post).toHaveBeenCalledWith({ system: { reboot: {} } });
    expect(out.rebooting).toBe(true);
    // running checksum 'aaa' vs saved 'bbbb…' => there were unsaved changes
    expect(out.unsavedChangesWereLost).toBe(true);
  });

  it('still reports success when the router drops the session mid-reply', async () => {
    const h = harness();
    h.post.mockRejectedValueOnce(new Error('fetch failed'));
    const out = payload(await h.handlers['reboot_router']!({ confirm: true }));
    expect(out.rebooting).toBe(true);
  });
});

describe('get_ping_check', () => {
  it('marks a profile with live data as active', async () => {
    const out = payload(await harness().handlers['get_ping_check']!({}));
    expect(out.active).toBe(true);
    expect(out.note).toBeUndefined();
  });

  // Captured from a KN-1810 on 5.2: the stock "default" profile, bound to nothing.
  it('explains a bare default profile instead of passing it through', async () => {
    const h = harness();
    DATA['show/ping-check'] = { pingcheck: [{ profile: 'default' }] };
    const out = payload(await h.handlers['get_ping_check']!({}));
    expect(out.active).toBe(false);
    expect(out.note).toMatch(/not probing anything/);
    DATA['show/ping-check'] = { profile: [{ name: 'default', status: 'ok' }] };
  });
});
