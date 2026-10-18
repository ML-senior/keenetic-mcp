import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { guard, ok, READ_ONLY, type ToolContext } from './registry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The band of a radio. KeeneticOS 5.x does not put a `band` field on the
 * WifiMaster record (measured on a KN-1810), so it is read from the channel
 * the radio is on: 1-14 only exist at 2.4 GHz, 32 and up at 5 GHz. A `band`
 * the firmware does report wins, and a 6 GHz radio - whose channel numbers
 * overlap both - is only named when the firmware says so.
 */
export function bandOf(master: Record<string, unknown>, channel: number | null): string {
  if (typeof master['band'] === 'string' && master['band'] !== '') return master['band'];
  const traits = Array.isArray(master['traits']) ? master['traits'].map(String) : [];
  if (traits.some(t => /6g/i.test(t))) return '6GHz';
  if (channel === null || channel <= 0) return 'unknown';
  if (channel <= 14) return '2.4GHz';
  return '5GHz';
}

export function registerNetworkTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_internet_status',
    {
      title: 'Internet connectivity',
      description:
        'Whether the router currently reaches the internet, and which check failed if not: ' +
        'gateway reachability, DNS resolution, and captive-portal detection. Start here when ' +
        'the user reports the internet is down.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const s = asRecord(await ctx.client.rci.get('show/internet/status'));
      return ok({
        internet: s['internet'] === true,
        checked: s['checked'] === true,
        enabled: s['enabled'] === true,
        reliable: s['reliable'] === true,
        gatewayAccessible: s['gateway-accessible'] === true,
        dnsAccessible: s['dns-accessible'] === true,
        captiveAccessible: s['captive-accessible'] === true
      });
    })
  );

  server.registerTool(
    'list_routes',
    {
      title: 'List IP routes',
      description:
        'The routing table: destination, gateway, outgoing interface and metric. ' +
        'Use kind=default to see only the default route, which tells you which link ' +
        'traffic leaves through.',
      inputSchema: {
        kind: z
          .enum(['all', 'default'])
          .optional()
          .describe('all returns the full table; default returns only 0.0.0.0/0.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rows. Defaults to 100.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ kind, limit }) => {
      const raw = await ctx.client.rci.get('show/ip/route');
      const routes = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const selected =
        kind === 'default' ? routes.filter(r => r['destination'] === '0.0.0.0/0') : routes;

      const capped = capList(selected, limit ?? 100, ctx.maxResponseBytes);
      return ok({
        routes: capped.items,
        shown: capped.shown,
        total: capped.total,
        ...(capped.note ? { note: capped.note } : {})
      });
    })
  );

  server.registerTool(
    'list_policies',
    {
      title: 'List routing policies',
      description:
        'Connection policies, which decide that a given device leaves through a given link - ' +
        'typically used to send some devices through a VPN tunnel and the rest direct. ' +
        'The names returned here are what a device is assigned to.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const raw = asRecord(await ctx.client.rci.get('ip/policy'));
      const policies = Object.entries(raw).map(([name, value]) => {
        const policy = asRecord(value);
        const permit = Array.isArray(policy['permit']) ? policy['permit'] : [];
        const interfaces = permit
          .map(entry => asRecord(entry)['interface'])
          .filter((id): id is string => typeof id === 'string');
        return {
          name,
          description: typeof policy['description'] === 'string' ? policy['description'] : '',
          interfaces
        };
      });
      return ok({ policies });
    })
  );

  server.registerTool(
    'get_wifi_status',
    {
      title: 'Wi-Fi status',
      description:
        'Wi-Fi radios grouped by band, each with its access points, SSIDs, link state and the ' +
        'number of connected clients. Use this rather than list_interfaces when the question ' +
        'is about Wi-Fi coverage or which network a device should be on.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const [ifaceRaw, assocRaw] = await Promise.all([
        ctx.client.rci.get('show/interface'),
        ctx.client.rci.get('show/associations')
      ]);
      const interfaces = asRecord(ifaceRaw);
      const stationsRaw = asRecord(assocRaw)['station'];
      const stations = Array.isArray(stationsRaw) ? stationsRaw.map(asRecord) : [];

      const clientsPerAp = new Map<string, number>();
      for (const station of stations) {
        const ap = typeof station['ap'] === 'string' ? station['ap'] : '';
        if (ap) clientsPerAp.set(ap, (clientsPerAp.get(ap) ?? 0) + 1);
      }

      // Band comes from the WifiMaster record itself, never from the index in its
      // name - that guess breaks on tri-band hardware.
      const bands = Object.entries(interfaces)
        .filter(([, value]) => asRecord(value)['type'] === 'WifiMaster')
        .map(([masterId, value]) => {
          const master = asRecord(value);
          const accessPoints = Object.entries(interfaces)
            .filter(
              ([apId, apValue]) =>
                apId.startsWith(`${masterId}/`) && asRecord(apValue)['type'] === 'AccessPoint'
            )
            .map(([apId, apValue]) => {
              const ap = asRecord(apValue);
              return {
                id: apId,
                ssid: typeof ap['ssid'] === 'string' ? ap['ssid'] : '',
                link: typeof ap['link'] === 'string' ? ap['link'] : '',
                state: typeof ap['state'] === 'string' ? ap['state'] : '',
                clients: clientsPerAp.get(apId) ?? 0
              };
            });

          const channel = typeof master['channel'] === 'number' ? master['channel'] : null;
          return {
            radio: masterId,
            band: bandOf(master, channel),
            channel,
            bandwidthMhz: master['bandwidth'] !== undefined ? Number(master['bandwidth']) : null,
            temperatureC: typeof master['temperature'] === 'number' ? master['temperature'] : null,
            description: typeof master['description'] === 'string' ? master['description'] : '',
            accessPoints
          };
        });

      return ok({ bands, totalClients: stations.length });
    })
  );
}
