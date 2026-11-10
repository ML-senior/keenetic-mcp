import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ValidationError } from '../router/errors.js';
import { asEntries, asRecord, numOrNull, str, type Row } from '../shape/coerce.js';
import { isMac, normMac } from '../shape/validate.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

/**
 * The router keeps its own traffic history - the graphs in its web interface
 * are drawn from it - as four round-robin archives of 64 points each. `detail`
 * picks the archive. Step sizes measured on a KN-1810, KeeneticOS 5.2.
 */
const PERIODS = {
  '3min': { detail: 0, stepSec: 3 },
  '1h': { detail: 1, stepSec: 60 },
  '3h': { detail: 2, stepSec: 180 },
  '1d': { detail: 3, stepSec: 1440 }
} as const;
type Period = keyof typeof PERIODS;

interface Sample {
  t: number;
  v: number;
}

/** Newest first, as the router sends them. Speeds are bits per second. */
function samples(rrd: unknown): Sample[] {
  return asEntries(asRecord(rrd)['data'])
    .map(point => ({ t: numOrNull(point['t']), v: numOrNull(point['v']) }))
    .filter((p): p is Sample => p.t !== null && p.v !== null);
}

const kbps = (bitsPerSecond: number): number => Math.round(bitsPerSecond / 100) / 10;

function stats(series: Sample[]): { avgKbps: number; peakKbps: number } {
  if (series.length === 0) return { avgKbps: 0, peakKbps: 0 };
  const sum = series.reduce((total, s) => total + s.v, 0);
  return {
    avgKbps: kbps(sum / series.length),
    peakKbps: kbps(Math.max(...series.map(s => s.v)))
  };
}

/** Two series on one clock: `[secondsAgo, firstKbps, secondKbps]`, oldest first. */
function merge(first: Sample[], second: Sample[]): Array<[number, number, number]> {
  const newest = Math.max(first[0]?.t ?? 0, second[0]?.t ?? 0);
  const other = new Map(second.map(s => [Math.round(s.t), s.v]));
  return first
    .map((s): [number, number, number] => [
      Math.round(newest - s.t),
      kbps(s.v),
      kbps(other.get(Math.round(s.t)) ?? 0)
    ])
    .reverse();
}

function rrdCommand(scope: 'interface' | 'host', id: string, attribute: string, detail: number): Row {
  const query = scope === 'interface' ? { name: id, attribute, detail } : { mac: id, attribute, detail };
  return scope === 'interface'
    ? { show: { interface: { rrd: query } } }
    : { show: { ip: { hotspot: { rrd: query } } } };
}

function rrdResult(scope: 'interface' | 'host', answer: unknown): unknown {
  const show = asRecord(asRecord(answer)['show']);
  return scope === 'interface'
    ? asRecord(show['interface'])['rrd']
    : asRecord(asRecord(asRecord(show['ip'])['hotspot'])['rrd']);
}

async function fetchHosts(ctx: ToolContext): Promise<Row[]> {
  return asEntries(asRecord(await ctx.client.rci.get('show/ip/hotspot'))['host']);
}

const hostLabel = (h: Row): string => str(h, 'name') || str(h, 'hostname') || str(h, 'mac');

/** A device by MAC, IP, or a name that points at exactly one. */
async function resolveHost(ctx: ToolContext, wanted: string): Promise<Row> {
  const hosts = await fetchHosts(ctx);
  const needle = wanted.trim().toLowerCase();
  const mac = isMac(needle) ? normMac(needle) : null;

  let matches = hosts.filter(
    h =>
      (mac !== null && str(h, 'mac').toLowerCase() === mac) ||
      str(h, 'ip') === needle ||
      str(h, 'name').toLowerCase() === needle ||
      str(h, 'hostname').toLowerCase() === needle
  );
  if (matches.length === 0) {
    matches = hosts.filter(
      h => str(h, 'name').toLowerCase().includes(needle) || str(h, 'hostname').toLowerCase().includes(needle)
    );
  }
  if (matches.length === 1) return matches[0] as Row;
  throw new ValidationError(
    matches.length === 0
      ? `No device matches "${wanted}". Call list_devices to see them.`
      : `${String(matches.length)} devices match "${wanted}": ` +
          `${matches.map(h => `${hostLabel(h)} (${str(h, 'mac')})`).join(', ')}. Use the MAC.`
  );
}

/** The interface carrying the default route: what "the internet connection" means. */
async function defaultInterface(ctx: ToolContext): Promise<string> {
  const interfaces = asRecord(await ctx.client.rci.get('show/interface'));
  for (const [id, value] of Object.entries(interfaces)) {
    if (asRecord(value)['defaultgw'] === true) return id;
  }
  throw new ValidationError(
    'No interface carries the default route, so there is no internet connection to measure. ' +
      'Name one with the interface argument (see list_interfaces).'
  );
}

export function registerTrafficTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_traffic',
    {
      title: 'Traffic over time',
      description:
        'Speed history for an interface or a single device, from the history the router ' +
        'itself keeps: average and peak speed over the period, the totals so far, and the ' +
        'series behind them. With no arguments it reports the internet connection over the ' +
        'last hour. Use it for "was the line busy an hour ago", "how much is the TV pulling", ' +
        'or to see when a slowdown started. Speeds are kbit/s; download and upload are from ' +
        'the point of view of the device or, for an interface, of the router. Each period is ' +
        '64 points: 3min in 3 s steps, 1h in 1 min, 3h in 3 min, 1d in 24 min.',
      inputSchema: {
        interface: z
          .string()
          .optional()
          .describe('Interface id from list_interfaces. Defaults to the one carrying the internet.'),
        device: z
          .string()
          .optional()
          .describe('A device instead of an interface: MAC, IP, or a name that matches one device.'),
        period: z.enum(['3min', '1h', '3h', '1d']).optional().describe('Defaults to 1h.'),
        series: z
          .boolean()
          .optional()
          .describe('false leaves out the point-by-point series and returns the summary only.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ interface: iface, device, period, series }): Promise<ToolResult> => {
      if (iface && device) {
        return fail(new ValidationError('Give interface or device, not both.'));
      }
      const chosen: Period = period ?? '1h';
      const { detail, stepSec } = PERIODS[chosen];

      const scope = device ? 'host' : 'interface';
      const host = device ? await resolveHost(ctx, device) : null;
      const id = host ? str(host, 'mac') : (iface ?? (await defaultInterface(ctx)));

      // One request for both directions, so the two series share a clock.
      const answers = await ctx.client.rci.post([
        rrdCommand(scope, id, 'rxspeed', detail),
        rrdCommand(scope, id, 'txspeed', detail)
      ]);
      const [rxRaw, txRaw] = Array.isArray(answers) ? answers : [];
      const rx = samples(rrdResult(scope, rxRaw));
      const tx = samples(rrdResult(scope, txRaw));
      if (rx.length === 0 && tx.length === 0) {
        return fail(
          new ValidationError(
            `The router returned no traffic history for ${scope === 'host' ? 'device' : 'interface'} "${id}". ` +
              (scope === 'interface' ? 'Check the id with list_interfaces.' : 'It may never have been online.')
          )
        );
      }

      // rx is what the subject received: a download for a device, and for the
      // WAN interface the router's download too. Checked against the byte
      // counters on a live router - a phone showed 37 GB rx against 0.6 GB tx.
      const result: Row = {
        ...(host
          ? { device: hostLabel(host), mac: id, ip: str(host, 'ip') || null, online: host['active'] === true }
          : { interface: id }),
        period: chosen,
        stepSeconds: stepSec,
        points: rx.length,
        download: stats(rx),
        upload: stats(tx)
      };

      if (host) {
        result['totals'] = { downloadBytes: numOrNull(host['rxbytes']), uploadBytes: numOrNull(host['txbytes']) };
      } else {
        try {
          const stat = asRecord(
            await ctx.client.rci.get(`show/interface/stat?name=${encodeURIComponent(id)}`)
          );
          result['now'] = {
            downloadKbps: kbps(numOrNull(stat['rxspeed']) ?? 0),
            uploadKbps: kbps(numOrNull(stat['txspeed']) ?? 0)
          };
          result['totals'] = {
            downloadBytes: numOrNull(stat['rxbytes']),
            uploadBytes: numOrNull(stat['txbytes']),
            rxErrors: numOrNull(stat['rxerrors']),
            txErrors: numOrNull(stat['txerrors']),
            rxDropped: numOrNull(stat['rxdropped']),
            txDropped: numOrNull(stat['txdropped'])
          };
        } catch {
          // The counters are an extra; the history stands without them.
        }
      }

      if (series !== false) {
        result['seriesColumns'] = ['secondsAgo', 'downloadKbps', 'uploadKbps'];
        result['series'] = merge(rx, tx);
      }
      return ok(result, ctx.maxResponseBytes);
    })
  );

  server.registerTool(
    'get_bandwidth_now',
    {
      title: 'Who is using the bandwidth right now',
      description:
        'The devices moving the most traffic at this moment, ranked, with the speed of ' +
        'each over the last few seconds. Use it when the connection is slow and the question ' +
        'is which device is responsible. list_devices sort=traffic ranks by lifetime totals, ' +
        'which says who has used the most ever, not who is busy now.',
      inputSchema: {
        window_sec: z
          .number()
          .int()
          .min(3)
          .max(180)
          .optional()
          .describe('How far back to average, in seconds. Defaults to 15.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum devices. Defaults to 10.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ window_sec, limit }): Promise<ToolResult> => {
      const points = Math.max(1, Math.round((window_sec ?? 15) / PERIODS['3min'].stepSec));
      // The busiest device is an online one; asking about the rest is two
      // commands each for nothing. Capped so one request stays one request.
      const hosts = (await fetchHosts(ctx)).filter(h => h['active'] === true && isMac(str(h, 'mac'))).slice(0, 60);
      if (hosts.length === 0) return ok({ devices: [], total: 0, note: 'No device is online.' });

      const commands = hosts.flatMap(h => [
        rrdCommand('host', str(h, 'mac'), 'rxspeed', 0),
        rrdCommand('host', str(h, 'mac'), 'txspeed', 0)
      ]);
      const raw = await ctx.client.rci.post(commands);
      const answers: unknown[] = Array.isArray(raw) ? raw : [];

      const recent = (answer: unknown): number => {
        const window = samples(rrdResult('host', answer)).slice(0, points);
        return window.length === 0 ? 0 : window.reduce((sum, s) => sum + s.v, 0) / window.length;
      };

      const devices = hosts
        .map((h, index) => {
          const down = recent(answers[index * 2]);
          const up = recent(answers[index * 2 + 1]);
          return {
            name: hostLabel(h),
            mac: str(h, 'mac'),
            ip: str(h, 'ip') || null,
            downloadKbps: kbps(down),
            uploadKbps: kbps(up),
            totalKbps: kbps(down + up)
          };
        })
        .sort((a, b) => b.totalKbps - a.totalKbps);

      const busy = devices.filter(d => d.totalKbps > 0);
      return ok(
        {
          windowSeconds: points * PERIODS['3min'].stepSec,
          devices: busy.slice(0, limit ?? 10),
          onlineDevices: hosts.length,
          idleDevices: devices.length - busy.length,
          totalDownloadKbps: kbps(devices.reduce((sum, d) => sum + d.downloadKbps * 1000, 0)),
          totalUploadKbps: kbps(devices.reduce((sum, d) => sum + d.uploadKbps * 1000, 0))
        },
        ctx.maxResponseBytes
      );
    })
  );
}
