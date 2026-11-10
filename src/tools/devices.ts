import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { runCli } from '../router/cli.js';
import { ValidationError } from '../router/errors.js';
import { asEntries, asRecord, type Row } from '../shape/coerce.js';
import { projectDevice, type DeviceSummary } from '../shape/project.js';
import { isMac, normMac } from '../shape/validate.js';
import {
  fail,
  guard,
  listResult,
  ok,
  READ_ONLY,
  WRITE,
  type ToolContext,
  type ToolResult
} from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

type HostRecord = Row;

async function fetchHosts(ctx: ToolContext): Promise<HostRecord[]> {
  return asEntries(asRecord(await ctx.client.rci.get('show/ip/hotspot'))['host']);
}

function sameMac(row: HostRecord, mac: string): boolean {
  return String(row['mac']).toLowerCase() === mac;
}

/** Case-insensitive substring match over what a person would type to find a device. */
function matchesSearch(host: HostRecord, device: DeviceSummary, needle: string): boolean {
  return [device.name, device.ip, device.mac, host['hostname'], host['name']].some(
    field => typeof field === 'string' && field.toLowerCase().includes(needle)
  );
}

/** Never-seen and unknown sort last, whichever way the list is ordered. */
function lastSeenRank(device: DeviceSummary): number {
  return device.lastSeenSec ?? Number.POSITIVE_INFINITY;
}

/** Reads one row out of a config branch that stores hosts as a MAC-keyed array. */
async function branchEntry(
  ctx: ToolContext,
  path: 'ip/hotspot/host' | 'known/host',
  mac: string
): Promise<HostRecord | undefined> {
  // asEntries, not Array.isArray: the router unwraps a branch holding a single
  // record into a bare object, and that must not read as "no rows".
  return asEntries(await ctx.client.rci.get(path)).find(row => sameMac(row, mac));
}

/**
 * Reads a host from the operational view.
 *
 * Needed for name verification: the `known/host` config branch returns only
 * `{mac}` and never echoes the name back, so a rename can only be confirmed
 * here. Assuming a config branch echoes what you wrote is exactly the mistake
 * that made an earlier version report every rename as failed.
 */
async function operationalHost(ctx: ToolContext, mac: string): Promise<HostRecord | undefined> {
  return (await fetchHosts(ctx)).find(row => sameMac(row, mac));
}

export function registerDeviceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_devices',
    {
      title: 'List devices on the network',
      description:
        'Every device the router knows about, with IP, name, how it is connected, signal ' +
        'strength and traffic counters. Use filter to narrow to active, wired, wireless or ' +
        'blocked devices, search to find one by part of its name, IP or MAC, and sort to ' +
        'rank by traffic, name, signal or last seen.',
      inputSchema: {
        filter: z
          .enum(['all', 'active', 'wired', 'wireless', 'blocked'])
          .optional()
          .describe('Which devices to include. Defaults to all.'),
        sort: z
          .enum(['traffic', 'name', 'rssi', 'last_seen'])
          .optional()
          .describe(
            'Ordering. Defaults to traffic, highest first. last_seen puts the most recently ' +
              'heard-from device first.'
          ),
        search: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the name, hostname, IP or MAC.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rows. Defaults to 50.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ filter, sort, search, limit }) => {
      const hosts = await fetchHosts(ctx);
      const needle = search?.trim().toLowerCase() ?? '';
      let devices = hosts
        .map(host => ({ host, device: projectDevice(host) }))
        .filter(({ host, device }) => needle === '' || matchesSearch(host, device, needle))
        .map(({ device }) => device);

      switch (filter) {
        case 'active':
          devices = devices.filter(d => d.active);
          break;
        case 'wired':
          devices = devices.filter(d => d.connection.startsWith('wired:'));
          break;
        case 'wireless':
          devices = devices.filter(d => d.connection.startsWith('wifi:'));
          break;
        case 'blocked':
          devices = devices.filter(d => d.blocked);
          break;
        default:
          break;
      }

      switch (sort) {
        case 'name':
          devices.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'rssi':
          devices.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
          break;
        case 'last_seen':
          // Seconds since last heard from, so ascending is most recent first.
          // This used to sort on `active` alone, which left every online
          // device in arbitrary order - not what the name promises.
          devices.sort(
            (a, b) => lastSeenRank(a) - lastSeenRank(b) || Number(b.active) - Number(a.active)
          );
          break;
        default:
          devices.sort((a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes));
          break;
      }

      return listResult('devices', devices, limit ?? 50, ctx.maxResponseBytes);
    })
  );

  server.registerTool(
    'get_device',
    {
      title: 'Get one device in full',
      description:
        'Every field the router holds for a single device: DHCP lease, Wi-Fi rate and mode, ' +
        'access policy, traffic shaping, first and last seen. Identify it by MAC, IP or name ' +
        '(the name is matched without regard to case; a unique partial name also works).',
      inputSchema: {
        mac: z.string().optional().describe('MAC address, any case.'),
        ip: z.string().optional().describe('Current IPv4 address.'),
        name: z.string().optional().describe('Registered name or hostname.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ mac, ip, name }): Promise<ToolResult> => {
      if (!mac && !ip && !name) {
        return fail(new Error('Supply one of mac, ip or name to identify the device.'));
      }

      const hosts = await fetchHosts(ctx);
      const label = (h: HostRecord): string => String(h['name'] || h['hostname'] || h['mac']);

      // An exact identifier wins outright: MAC, then IP, then the full name.
      const wantedMac = mac && isMac(mac) ? normMac(mac) : mac?.trim().toLowerCase();
      const wantedName = name?.trim().toLowerCase();
      const names = (h: HostRecord): string[] =>
        [h['name'], h['hostname']]
          .filter((v): v is string => typeof v === 'string' && v !== '')
          .map(v => v.toLowerCase());

      let matches = hosts.filter(
        h =>
          (wantedMac !== undefined && wantedMac !== '' && sameMac(h, wantedMac)) ||
          (ip !== undefined && ip !== '' && h['ip'] === ip.trim()) ||
          (wantedName !== undefined && wantedName !== '' && names(h).includes(wantedName))
      );
      // Only then a partial name - and only if it points at exactly one device.
      if (matches.length === 0 && wantedName) {
        matches = hosts.filter(h => names(h).some(n => n.includes(wantedName)));
      }

      if (matches.length === 0) {
        const known = hosts.map(label).join(', ');
        return fail(
          new ValidationError(
            `No device matched. Known devices: ${known || 'none'}. ` +
              'Call list_devices to see them with their addresses.'
          )
        );
      }
      if (matches.length > 1) {
        return fail(
          new ValidationError(
            `${String(matches.length)} devices match: ` +
              matches.map(h => `${label(h)} (${String(h['mac'])})`).join(', ') +
              '. Identify the one you mean by its MAC.'
          )
        );
      }
      return ok(matches[0], ctx.maxResponseBytes);
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'wake_device',
    {
      title: 'Wake a device (Wake-on-LAN)',
      description:
        'Has the router send a Wake-on-LAN magic packet to a device on its network, to turn ' +
        'on a sleeping or powered-off PC, NAS or server. The device must be wired, have ' +
        'Wake-on-LAN enabled in its firmware, and be known to the router. The packet is ' +
        'sent blind: there is no acknowledgement, so check with list_devices a minute later ' +
        'whether it came up. Changes nothing in the router configuration.',
      inputSchema: {
        mac: z.string().describe('MAC address of the device to wake, any case.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    guard(async ({ mac: rawMac }): Promise<ToolResult> => {
      const mac = normMac(rawMac);
      const host = await operationalHost(ctx, mac);
      await runCli(ctx.client.rci, `ip hotspot wake ${mac}`);
      return ok({
        sent: true,
        mac,
        device: host ? String(host['name'] || host['hostname'] || mac) : null,
        wasOnline: host ? host['active'] === true : null,
        note: host
          ? 'Magic packet sent. Give it up to a minute, then check with list_devices.'
          : 'Magic packet sent, but the router does not know this MAC - check the address.'
      });
    })
  );

  server.registerTool(
    'update_device',
    {
      title: 'Change a device',
      description:
        'Rename a device, allow or block its internet access, put it on a routing policy ' +
        'or a schedule, or set its traffic priority. Changes apply immediately but are ' +
        'NOT saved: a reboot discards them until save_config is called.',
      inputSchema: {
        mac: z.string().describe('MAC address of the device, any case.'),
        name: z.string().optional().describe('New name. Also registers the device.'),
        access: z.enum(['permit', 'deny']).optional().describe('Allow or block internet access.'),
        policy: z.string().optional().describe('Policy name from list_policies.'),
        schedule: z.string().optional().describe('Schedule name.'),
        priority: z.number().int().min(0).max(7).optional().describe('Traffic priority, 0 to 7.')
      },
      annotations: WRITE
    },
    guard(async ({ mac: rawMac, name, access, policy, schedule, priority }): Promise<ToolResult> => {
      // Normalized before anything is sent: the router compares MACs as
      // strings, so `AA-BB-...` is accepted, changes nothing, and then fails
      // verification with a message that blames the wrong thing.
      const mac = normMac(rawMac);
      if (
        name === undefined &&
        access === undefined &&
        policy === undefined &&
        schedule === undefined &&
        priority === undefined
      ) {
        return fail(
          new Error(
            'Nothing to change. Supply at least one of name, access, policy, schedule or priority.'
          )
        );
      }

      const snapshot = await ctx.backup.ensure();
      const applied: Record<string, unknown> = {};

      // name first: ip/hotspot refuses every setting for a host that is not
      // registered in the known branch.
      if (name !== undefined) {
        await verifiedWrite({
          apply: () => ctx.client.rci.post({ known: { host: { mac, name } } }),
          readBack: () => operationalHost(ctx, mac),
          check: row => row?.['name'] === name,
          what: `name=${name}`
        });
        applied['name'] = name;
      }

      if (access !== undefined) {
        const body =
          access === 'deny'
            ? { ip: { hotspot: { host: { mac, deny: true } } } }
            : { ip: { hotspot: { host: { mac, permit: true } } } };
        await verifiedWrite({
          apply: () => ctx.client.rci.post(body),
          readBack: () => branchEntry(ctx, 'ip/hotspot/host', mac),
          check: row => row?.['access'] === access,
          what: `access=${access}`
        });
        applied['access'] = access;
      }

      for (const [field, value] of [
        ['policy', policy],
        ['schedule', schedule],
        ['priority', priority]
      ] as const) {
        if (value === undefined) continue;
        await verifiedWrite({
          apply: () => ctx.client.rci.post({ ip: { hotspot: { host: { mac, [field]: value } } } }),
          readBack: () => branchEntry(ctx, 'ip/hotspot/host', mac),
          check: row => row?.[field] === value,
          what: `${field}=${String(value)}`
        });
        applied[field] = value;
      }

      return ok(describeWrite(applied, snapshot.path));
    })
  );
}
