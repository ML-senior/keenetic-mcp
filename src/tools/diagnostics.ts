import { execFile } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { readConfigState } from '../router/config-state.js';
import { guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEntries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(v => typeof v === 'object' && v !== null) as Array<Record<string, unknown>>;
  }
  if (typeof value === 'object' && value !== null) return [value as Record<string, unknown>];
  return [];
}

function mb(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n / 1048576) * 10) / 10 : null;
}

/** Hosts as seen by the hotspot table: the one view that knows mesh extenders. */
async function fetchHotspotHosts(ctx: ToolContext): Promise<Array<Record<string, unknown>>> {
  const raw = asRecord(await ctx.client.rci.get('show/ip/hotspot'));
  return asEntries(raw['host']);
}

function pingLocal(host: string, count: number): Promise<string> {
  const args =
    process.platform === 'win32'
      ? ['-n', String(count), '-w', '2000', host]
      : ['-c', String(count), '-W', '2', host];
  return new Promise((resolve, reject) => {
    execFile('ping', args, { timeout: 30_000 }, (error, stdout, stderr) => {
      // ping exits non-zero on packet loss, which is a valid answer, not a failure.
      if (stdout) return resolve(stdout);
      if (error && !stderr) return reject(error);
      resolve(stderr || `ping failed: ${error?.message ?? 'unknown error'}`);
    });
  });
}

export function registerDiagnosticsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_log',
    {
      title: 'Read the system log',
      description:
        'The router system log as text, newest entries last. Use lines to bound how much ' +
        'comes back and filter for a case-insensitive substring (a device name, "wan", ' +
        '"dhcp"...). Entries stamped before NTP synchronized can carry wrong dates.',
      inputSchema: {
        lines: z.number().int().min(1).max(2000).optional().describe('How many lines from the end. Defaults to 100.'),
        filter: z.string().optional().describe('Case-insensitive substring filter.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ lines, filter }) => {
      const text = await ctx.client.rci.getText('/ci/log');
      let entries = text.split('\n').filter(l => l.trim().length > 0);
      if (filter) {
        const needle = filter.toLowerCase();
        entries = entries.filter(l => l.toLowerCase().includes(needle));
      }
      const total = entries.length;
      const wanted = lines ?? 100;
      return ok(
        {
          log: entries.slice(-wanted).join('\n'),
          shown: Math.min(wanted, total),
          total
        },
        ctx.maxResponseBytes
      );
    })
  );

  server.registerTool(
    'run_ping',
    {
      title: 'Ping a host',
      description:
        'Pings a host FROM THE MACHINE RUNNING THIS SERVER, not from the router - ' +
        'arbitrary router-side ping is not exposed over the router API. For the ' +
        'router-side view of connectivity use get_internet_status or get_ping_check.',
      inputSchema: {
        host: z.string().describe('Hostname or IP address to ping.'),
        count: z.number().int().min(1).max(10).optional().describe('Packets to send. Defaults to 4.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    guard(async ({ host, count }): Promise<ToolResult> => {
      const trimmed = host.trim();
      // execFile passes arguments without a shell, but a leading dash would be
      // read as a flag, and whitespace/control chars are never part of a host.
      if (!/^[a-z0-9.:_-]+$/i.test(trimmed) || trimmed.startsWith('-')) {
        return { content: [{ type: 'text', text: `'${host}' is not a valid hostname or IP address.` }], isError: true };
      }
      const output = await pingLocal(trimmed, count ?? 4);
      return ok({ host: trimmed, output }, ctx.maxResponseBytes);
    })
  );

  server.registerTool(
    'get_ping_check',
    {
      title: 'Ping-check monitor status',
      description:
        'State of the router-side ping-check: the periodic reachability probes the router ' +
        'itself runs for its internet connections. This is the router-side answer when ' +
        'run_ping (which pings from the server machine) is not what you need.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const raw = await ctx.client.rci.get('show/ping-check');
      return ok(raw, ctx.maxResponseBytes);
    })
  );

  server.registerTool(
    'get_mesh_nodes',
    {
      title: 'List Mesh Wi-Fi nodes',
      description:
        'The Mesh Wi-Fi system: the controller and every extender, with model, firmware, ' +
        'connection speed and how many clients hang off each. A single-router network ' +
        'returns just the controller.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const [hosts, versionRaw] = await Promise.all([
        fetchHotspotHosts(ctx),
        ctx.client.rci.get('show/version')
      ]);
      const version = asRecord(versionRaw);

      const clients = hosts.filter(h => h['active'] === true && !h['system-mode']);
      const extenders = hosts.filter(h => h['system-mode'] === 'extender');

      const nodes: Array<Record<string, unknown>> = [
        {
          role: 'controller',
          name: version['description'] ?? '',
          model: version['hw_id'] ?? '',
          firmware: version['release'] ?? version['title'] ?? '',
          activeClients: clients.filter(h => !h['mws-backhaul']).length
        }
      ];
      for (const e of extenders) {
        nodes.push({
          role: 'extender',
          name: e['name'] ?? '',
          model: e['description'] ?? '',
          firmware: e['firmware'] ?? '',
          ip: e['ip'] ?? null,
          mac: e['mac'] ?? null,
          active: e['active'] === true,
          connectionSpeedMbps: e['speed'] ?? null,
          uptimeSec: e['uptime'] ?? null,
          activeClients: clients.filter(h => h['mws-backhaul']).length
        });
      }
      return ok({ nodes, totalActiveClients: clients.length });
    })
  );

  server.registerTool(
    'get_media',
    {
      title: 'List attached storage',
      description:
        'Internal flash and USB drives: partitions with filesystem, label, free space and ' +
        'which subsystem uses them (e.g. opkg for Entware). Use it to check whether the ' +
        'Entware drive is healthy.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const data = asRecord(await ctx.client.rci.get('show/media'));
      const partitions: Array<Record<string, unknown>> = [];
      for (const [mediaName, mediaValue] of Object.entries(data)) {
        const media = asRecord(mediaValue);
        for (const [partId, partValue] of Object.entries(asRecord(media['partition']))) {
          const part = asRecord(partValue);
          partitions.push({
            media: mediaName,
            bus: media['bus'] ?? null,
            product: typeof media['product'] === 'string' ? media['product'].trim() : null,
            mediaState: media['state'] ?? null,
            partition: partId,
            uuid: part['uuid'] ?? null,
            label: part['label'] ?? null,
            fstype: part['fstype'] ?? null,
            state: part['state'] ?? null,
            totalMb: mb(part['total']),
            freeMb: mb(part['free']),
            usedBy: part['used-by'] ?? []
          });
        }
      }
      return ok({ partitions, total: partitions.length });
    })
  );

  server.registerTool(
    'get_opkg_status',
    {
      title: 'Entware (OPKG) status',
      description:
        'The OPKG configuration: which drive Entware is bound to and its init script. ' +
        'Whether /opt is actually mounted can only be checked on the router itself - ' +
        'this tool reports the configuration side.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const info = await ctx.client.rci.get('opkg');
      return ok({ opkg: info }, ctx.maxResponseBytes);
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'reboot_router',
    {
      title: 'Reboot the router',
      description:
        'Reboots the router. Requires confirm=true. A reboot DISCARDS every unsaved ' +
        'change made since the last save_config - the result reports whether any were ' +
        'pending. The router answers for a moment, then goes silent for a minute or two.',
      inputSchema: {
        confirm: z.literal(true).describe('Must be true. Ask the user before setting it.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async () => {
      const state = await readConfigState(ctx.client.rci);
      try {
        await ctx.client.rci.post({ system: { reboot: {} } });
      } catch {
        // The router drops the management session while going down; a failed
        // response read is the expected shape of success here.
      }
      return ok({
        rebooting: true,
        unsavedChangesWereLost: state.unsavedChanges === true,
        note:
          state.unsavedChanges === true
            ? 'There were unsaved configuration changes. They are gone; redo them and call save_config.'
            : 'No unsaved changes were pending.'
      });
    })
  );
}
