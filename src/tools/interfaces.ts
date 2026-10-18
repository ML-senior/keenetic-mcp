import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { projectInterface } from '../shape/project.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

type InterfaceKind = 'all' | 'wan' | 'lan' | 'wifi' | 'vpn' | 'bridge';

/**
 * Reads one interface by name.
 *
 * Asked through POST rather than by building `show/interface/<name>`: every
 * Wi-Fi access point is named like `WifiMaster0/AccessPoint0`, and the slash is
 * read as a further path segment, so the GET form is a 404 for exactly the
 * interfaces list_interfaces reports under kind=wifi.
 */
async function readInterface(ctx: ToolContext, name: string): Promise<Record<string, unknown>> {
  const raw = await ctx.client.rci.post({ show: { interface: { name } } });
  const outer = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const show = typeof outer['show'] === 'object' && outer['show'] !== null
    ? (outer['show'] as Record<string, unknown>)
    : {};
  const record = show['interface'];
  return typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
}

const VPN_TYPES = new Set(['Wireguard', 'OpenVPN', 'L2TP', 'PPTP', 'IPsec', 'Sstp']);

/** Connection policies that route through `name`, by policy name and description. */
async function policiesUsing(ctx: ToolContext, name: string): Promise<Array<{ policy: string; description: string }>> {
  const raw = await ctx.client.rci.get('ip/policy');
  const tree = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Array<{ policy: string; description: string }> = [];
  for (const [policy, value] of Object.entries(tree)) {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const permits = Array.isArray(record['permit']) ? record['permit'] : record['permit'] ? [record['permit']] : [];
    const uses = permits.some(
      entry => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['interface'] === name
    );
    if (uses) {
      out.push({ policy, description: typeof record['description'] === 'string' ? record['description'] : '' });
    }
  }
  return out;
}

function isNotFound(error: unknown): boolean {
  return /404|does not exist|not found|unable to find/i.test((error as Error)?.message ?? '');
}

function matchesKind(id: string, record: Record<string, unknown>, kind: InterfaceKind): boolean {
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  switch (kind) {
    case 'wan':
      return record['role'] === 'inet' || record['defaultgw'] === true;
    case 'wifi':
      return id.includes('WifiMaster') || type === 'AccessPoint';
    case 'vpn':
      return VPN_TYPES.has(type);
    case 'bridge':
      return type === 'Bridge';
    case 'lan':
      return type === 'Bridge' || type.includes('Ethernet');
    default:
      return true;
  }
}

export function registerInterfaceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_interfaces',
    {
      title: 'List network interfaces',
      description:
        'Every interface on the router - WAN links, bridges, Wi-Fi access points and VPN ' +
        'tunnels - with link state, address and whether it carries the default route. ' +
        'Summary detail is the default because the full listing is very large.',
      inputSchema: {
        kind: z
          .enum(['all', 'wan', 'lan', 'wifi', 'vpn', 'bridge'])
          .optional()
          .describe('Which interfaces to include. Defaults to all.'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe('summary returns seven fields per interface; full returns every field.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum rows. Defaults to 100.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ kind, detail, limit }) => {
      const raw = await ctx.client.rci.get('show/interface');
      const all = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

      const selected = Object.entries(all).filter(([id, record]) =>
        matchesKind(
          id,
          typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {},
          kind ?? 'all'
        )
      );

      const shaped =
        detail === 'full'
          ? selected.map(([id, record]) => ({ id, ...(record as Record<string, unknown>) }))
          : selected.map(([id, record]) => projectInterface(id, record));

      const capped = capList(shaped, limit ?? 100, ctx.maxResponseBytes);
      return ok({
        interfaces: capped.items,
        shown: capped.shown,
        total: capped.total,
        ...(capped.note ? { note: capped.note } : {})
      });
    })
  );

  server.registerTool(
    'get_interface',
    {
      title: 'Get one interface in full',
      description:
        'Every field for a single interface, including protocol-specific detail such as ' +
        'WireGuard peers or PPPoE session state. Get the exact name from list_interfaces first.',
      inputSchema: {
        name: z.string().describe('Interface id, for example Bridge0 or Wireguard3.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ name }): Promise<ToolResult> => {
      try {
        return ok(await readInterface(ctx, name));
      } catch (error) {
        return fail(
          new Error(
            `Could not read interface "${name}": ${(error as Error).message} ` +
              'Call list_interfaces to see the exact ids available on this router.'
          )
        );
      }
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'set_interface_state',
    {
      title: 'Bring an interface up or down',
      description:
        'Enables or disables a network interface. Taking down a bridge or the WAN link ' +
        'can cut off access to the router itself, including this connection. Confirm what ' +
        'the interface carries with get_interface before calling this.',
      inputSchema: {
        name: z.string().describe('Interface id from list_interfaces.'),
        state: z.enum(['up', 'down']).describe('Desired administrative state.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ name, state }): Promise<ToolResult> => {
      const snapshot = await ctx.backup.ensure();
      const body =
        state === 'up'
          ? { interface: { [name]: { up: true } } }
          : { interface: { [name]: { up: { no: true } } } };

      await verifiedWrite({
        apply: () => ctx.client.rci.post(body),
        readBack: () => readInterface(ctx, name),
        check: record => record['state'] === state,
        what: `${name} state=${state}`
      });

      return ok(describeWrite({ interface: name, state }, snapshot.path));
    })
  );

  server.registerTool(
    'delete_interface',
    {
      title: 'Delete a VPN tunnel interface',
      description:
        'Removes a VPN interface (WireGuard, OpenVPN, L2TP, PPTP, IPsec, SSTP) together with ' +
        'its keys and peers. The router also drops it from every connection policy; the ' +
        'result lists which policies lost it, so devices on them now leave through what is ' +
        'left. Refuses physical interfaces, bridges (use delete_segment) and whatever carries ' +
        'the default route. NOT saved until save_config.',
      inputSchema: {
        name: z.string().describe('Interface id from list_interfaces, for example Wireguard0.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ name }): Promise<ToolResult> => {
      let record: Record<string, unknown>;
      try {
        record = await readInterface(ctx, name);
      } catch (error) {
        if (isNotFound(error)) {
          return fail(new Error(`There is no interface "${name}". Call list_interfaces for the exact ids.`));
        }
        throw error;
      }
      const type = typeof record['type'] === 'string' ? record['type'] : '';
      if (!VPN_TYPES.has(type)) {
        return fail(
          new Error(
            `"${name}" is a ${type || 'non-VPN'} interface; delete_interface only removes VPN tunnels. ` +
              (type === 'Bridge' ? 'Use delete_segment for a network segment.' : 'Nothing was changed.')
          )
        );
      }
      if (record['defaultgw'] === true) {
        return fail(
          new Error(
            `"${name}" carries the default route; deleting it would cut the internet off. ` +
              'Move the default route first. Nothing was changed.'
          )
        );
      }

      const policies = await policiesUsing(ctx, name);
      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ interface: { [name]: { no: true } } }),
        readBack: async () => {
          try {
            await readInterface(ctx, name);
            return false;
          } catch (error) {
            if (isNotFound(error)) return true;
            throw error;
          }
        },
        check: gone => gone,
        what: `removal of ${name}`
      });

      return ok({
        ...describeWrite({ deleted: name, type }, snapshot.path),
        removedFromPolicies: policies,
        ...(policies.length > 0
          ? {
              policyNote:
                'These policies no longer route through the tunnel. A policy left with only the ' +
                'WAN connection behaves like no policy; review them with list_policies.'
            }
          : {})
      });
    })
  );
}
