import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ValidationError } from '../router/errors.js';
import {
  adviseChannel,
  bandOfChannel,
  channelLoads,
  type SurveyCell
} from '../shape/channels.js';
import { asEntries, asRecord, numOrNull, str, type Row } from '../shape/coerce.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

interface Radio {
  id: string;
  channel: number | null;
  widthMhz: number | null;
  ssids: Set<string>;
}

/** The radios that are switched on, each with the SSIDs it broadcasts. */
async function readRadios(ctx: ToolContext): Promise<Radio[]> {
  const interfaces = asRecord(await ctx.client.rci.get('show/interface'));
  const radios: Radio[] = [];
  for (const [id, value] of Object.entries(interfaces)) {
    const record = asRecord(value);
    if (record['type'] !== 'WifiMaster') continue;
    const ssids = new Set<string>();
    for (const [apId, apValue] of Object.entries(interfaces)) {
      if (!apId.startsWith(`${id}/`)) continue;
      const ssid = str(asRecord(apValue), 'ssid');
      if (ssid) ssids.add(ssid);
    }
    radios.push({
      id,
      channel: numOrNull(record['channel']),
      widthMhz: numOrNull(record['bandwidth']),
      ssids
    });
  }
  return radios;
}

function toCell(raw: Row, own: Set<string>): SurveyCell | null {
  const channel = numOrNull(raw['channel']);
  const rssi = numOrNull(raw['rssi']);
  if (channel === null || rssi === null) return null;
  const ssid = str(raw, 'essid');
  const occupied = Array.isArray(raw['busy-channels'])
    ? raw['busy-channels'].map(numOrNull).filter((c): c is number => c !== null)
    : [];
  return {
    ssid,
    bssid: str(raw, 'address'),
    channel,
    occupied,
    widthMhz: numOrNull(raw['bandwidth']),
    rssi,
    // Recognised by SSID: this router's own access points and its Mesh nodes
    // broadcast the same names, and they are not neighbours to steer away from.
    own: ssid !== '' && own.has(ssid)
  };
}

async function survey(ctx: ToolContext, radio: Radio, own: Set<string>): Promise<SurveyCell[]> {
  // By name through POST: the GET form cannot carry the radio's name.
  const raw = asRecord(await ctx.client.rci.post({ show: { 'site-survey': { name: radio.id } } }));
  const cells = asEntries(asRecord(asRecord(raw['show'])['site-survey'])['ap_cell']);
  return cells.map(cell => toCell(cell, own)).filter((c): c is SurveyCell => c !== null);
}

export function registerWifiTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_wifi_survey',
    {
      title: 'Survey the Wi-Fi neighbourhood',
      description:
        'What the router hears on the air: neighbouring networks per radio with channel, ' +
        'width and signal, how congested each channel is, and whether the radio would be ' +
        'better off on another one. Use it when Wi-Fi is slow or unstable, or before ' +
        'choosing a channel. Congestion scores only compare channels within one survey. ' +
        'The recommendation weighs signal strength and overlap; it does not see non-Wi-Fi ' +
        'interference. Changing the channel itself is not done here. CAUTION: to listen ' +
        'for neighbours a radio leaves its own channel, which can stall or drop the Wi-Fi ' +
        'clients on it for a few seconds. One radio is surveyed per call for that reason. ' +
        'If the user - or this very session - reaches the network over Wi-Fi, say so and ' +
        'ask before running it.',
      inputSchema: {
        radio: z
          .string()
          .optional()
          .describe(
            'The radio to survey, e.g. WifiMaster0. Leave it out to get the list of radios ' +
              'without surveying anything.'
          ),
        neighbours: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe('How many of the strongest neighbours to list per radio. Defaults to 8.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ radio, neighbours }): Promise<ToolResult> => {
      const all = await readRadios(ctx);
      // No radio named: list them and touch nothing. A survey takes the radio
      // off its channel, so it is never the default and never done to every
      // radio at once - that would stall the whole Wi-Fi network together.
      if (radio === undefined || radio.trim() === '') {
        return ok({
          radios: all.map(r => ({ radio: r.id, channel: r.channel, widthMhz: r.widthMhz, ssids: [...r.ssids] })),
          note:
            'Nothing was surveyed. Call again with radio set to one of these. A survey can ' +
            'interrupt Wi-Fi clients on that radio for a few seconds.'
        });
      }
      const wanted = all.filter(r => r.id.toLowerCase() === radio.trim().toLowerCase());
      if (wanted.length === 0) {
        return fail(
          new ValidationError(
            `No radio named "${radio}". Radios: ${all.map(r => r.id).join(', ') || 'none'}.`
          )
        );
      }
      const own = new Set(all.flatMap(r => [...r.ssids]));
      const top = neighbours ?? 8;

      const radios = [];
      for (const r of wanted) {
        let cells: SurveyCell[];
        try {
          cells = await survey(ctx, r, own);
        } catch (error) {
          radios.push({ radio: r.id, error: (error as Error).message });
          continue;
        }
        // The band comes from where the radio is, falling back to what it hears.
        const reference = r.channel ?? cells[0]?.channel ?? null;
        if (reference === null) {
          radios.push({ radio: r.id, channel: null, networksHeard: 0, note: 'The radio is off or heard nothing.' });
          continue;
        }
        const band = bandOfChannel(reference);
        const foreign = cells.filter(c => !c.own);
        const loads = channelLoads(cells, band);

        radios.push({
          radio: r.id,
          band,
          channel: r.channel,
          widthMhz: r.widthMhz,
          networksHeard: foreign.length,
          ownNetworksHeard: cells.length - foreign.length,
          advice: adviseChannel(loads, band, r.channel),
          // Quiet channels are the uninteresting majority at 5 GHz.
          channelLoad: loads.filter(l => l.networks > 0 || l.channel === r.channel),
          strongestNeighbours: [...foreign]
            .sort((a, b) => b.rssi - a.rssi)
            .slice(0, top)
            .map(c => ({
              ssid: c.ssid || '(hidden)',
              channel: c.channel,
              widthMhz: c.widthMhz,
              rssi: c.rssi
            }))
        });
      }
      return ok({ radios }, ctx.maxResponseBytes);
    })
  );
}
