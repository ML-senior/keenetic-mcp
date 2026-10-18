import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { RciError } from '../../src/router/errors.js';
import { registerInterfaceTools } from '../../src/tools/interfaces.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const POLICIES = {
  Policy0: { description: 'AWG', permit: [{ interface: 'Wireguard0' }, { interface: 'PPPoE0' }] },
  Policy1: { description: 'Direct', permit: { interface: 'PPPoE0' } }
};

function harness(interfaces: Record<string, Record<string, unknown>>, obeys = true) {
  const live = structuredClone(interfaces);
  const writes: unknown[] = [];
  const post = vi.fn(async (body: unknown) => {
    const name = (body as { show?: { interface?: { name?: string } } }).show?.interface?.name;
    if (name !== undefined) {
      if (!(name in live)) {
        throw new RciError(`unable to find "${name}".`, { path: 'POST /rci/', code: '6553619', ident: 'x' });
      }
      return { show: { interface: { id: name, ...live[name] } } };
    }
    writes.push(body);
    if (obeys) for (const key of Object.keys((body as { interface: object }).interface)) delete live[key];
    return {};
  });
  const client = {
    rci: { get: vi.fn(async () => structuredClone(POLICIES)), post, getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;
  const ctx: ToolContext = { client, maxResponseBytes: 25_000, readOnly: false, backup: stubBackup() };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((n: string, _c: unknown, h: Handler) => {
    handlers[n] = h;
    return {} as never;
  }) as never);
  registerInterfaceTools(server, ctx);
  return { handlers, writes };
}

const payload = (r: ToolResult): any => JSON.parse(r.content.map(p => p.text).join(''));

describe('delete_interface', () => {
  it('removes a tunnel, verifies it is gone, and names the policies that lost it', async () => {
    const { handlers, writes } = harness({ Wireguard0: { type: 'Wireguard', defaultgw: false } });
    const result = await handlers['delete_interface']!({ name: 'Wireguard0' });
    expect(result.isError).toBeUndefined();
    expect(writes).toEqual([{ interface: { Wireguard0: { no: true } } }]);
    const out = payload(result);
    expect(out.removedFromPolicies).toEqual([{ policy: 'Policy0', description: 'AWG' }]);
    expect(out.saved).toBe(false);
  });

  it('refuses a physical or bridge interface', async () => {
    const { handlers, writes } = harness({ Bridge0: { type: 'Bridge' }, GigabitEthernet1: { type: 'GigabitEthernet' } });
    expect((await handlers['delete_interface']!({ name: 'Bridge0' })).isError).toBe(true);
    expect((await handlers['delete_interface']!({ name: 'GigabitEthernet1' })).isError).toBe(true);
    expect(writes).toEqual([]);
  });

  it('refuses the tunnel that carries the default route', async () => {
    const { handlers, writes } = harness({ Wireguard1: { type: 'Wireguard', defaultgw: true } });
    const result = await handlers['delete_interface']!({ name: 'Wireguard1' });
    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
  });

  it('says so when the interface does not exist', async () => {
    const { handlers } = harness({});
    const result = await handlers['delete_interface']!({ name: 'Wireguard9' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no interface "Wireguard9"/);
  });

  it('does not claim success when the router ignores the command', async () => {
    const { handlers } = harness({ Wireguard0: { type: 'Wireguard' } }, false);
    const result = await handlers['delete_interface']!({ name: 'Wireguard0' });
    expect(result.isError).toBe(true);
  });
});
