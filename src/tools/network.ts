import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { guard, listResult, ok, READ_ONLY, type ToolContext } from './registry.js';
import { asEntries, asRecord, numOrNull, str } from '../shape/coerce.js';

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
      const routes = asEntries(await ctx.client.rci.get('show/ip/route'));
      const selected =
        kind === 'default' ? routes.filter(r => r['destination'] === '0.0.0.0/0') : routes;
      return listResult('routes', selected, limit ?? 100, ctx.maxResponseBytes);
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
        // asEntries: a single-element list may come back unwrapped, which
        // delete_interface already allowed for and this listing did not.
        const interfaces = asEntries(policy['permit'])
          .map(entry => entry['interface'])
          .filter((id): id is string => typeof id === 'string');
        return { name, description: str(policy, 'description'), interfaces };
      });
      return ok({ policies });
    })
  );

  server.registerTool(
    'list_schedules',
    {
      title: 'List schedules',
      description:
        'The schedules defined on the router, each as the weekly intervals during which it ' +
        'is on. These are the names update_device takes for its schedule argument, to limit ' +
        'when a device has internet access.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const raw = asRecord(await ctx.client.rci.get('show/schedule'));
      // Wrapped in `schedule` on the releases measured; taken bare otherwise.
      const tree = raw['schedule'] !== undefined ? asRecord(raw['schedule']) : raw;
      const schedules = Object.entries(tree).map(([name, value]) => {
        const record = asRecord(value);
        const actions = asEntries(record['action']);
        // The router lists alternating start and stop events in week order;
        // each start is paired with the stop that follows it.
        const intervals: string[] = [];
        let open: { dow: string; time: string } | null = null;
        for (const action of actions) {
          const dow = str(action, 'dow');
          const time = str(action, 'time');
          if (action['type'] === 'start') {
            open = { dow, time };
          } else if (action['type'] === 'stop' && open) {
            intervals.push(
              open.dow === dow ? `${dow} ${open.time}-${time}` : `${open.dow} ${open.time} - ${dow} ${time}`
            );
            open = null;
          }
        }
        const next = actions
          .map(a => ({ type: str(a, 'type'), left: numOrNull(a['left']) }))
          .filter((a): a is { type: string; left: number } => a.left !== null)
          .sort((a, b) => a.left - b.left)[0];
        return {
          name,
          description: str(record, 'description'),
          intervals,
          // The next event being a stop means the schedule is on right now.
          ...(next ? { activeNow: next.type === 'stop', nextChange: `${next.type} in ${String(next.left)} s` } : {})
        };
      });
      return ok({ schedules, total: schedules.length }, ctx.maxResponseBytes);
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
      const stations = asEntries(asRecord(assocRaw)['station']);

      const clientsPerAp = new Map<string, number>();
      for (const station of stations) {
        const ap = str(station, 'ap');
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
                ssid: str(ap, 'ssid'),
                link: str(ap, 'link'),
                state: str(ap, 'state'),
                clients: clientsPerAp.get(apId) ?? 0
              };
            });

          const channel = numOrNull(master['channel']);
          return {
            radio: masterId,
            band: bandOf(master, channel),
            channel,
            bandwidthMhz: numOrNull(master['bandwidth']),
            temperatureC: numOrNull(master['temperature']),
            description: str(master, 'description'),
            accessPoints
          };
        });

      return ok({ bands, totalClients: stations.length });
    })
  );
}
