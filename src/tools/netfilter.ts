import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ValidationError } from '../router/errors.js';
import { parseNetfilter, ruleText, type NetfilterTable } from '../router/netfilter.js';
import { fail, guard, listResult, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

/**
 * The listing as text. On KeeneticOS 5.x `show/netfilter` answers with one
 * JSON string holding the whole thing; older releases are reported to send it
 * bare, which the JSON reader refuses - so that case goes to the text reader.
 */
async function readNetfilter(ctx: ToolContext): Promise<string> {
  try {
    const raw = await ctx.client.rci.get('show/netfilter');
    if (typeof raw === 'string') return raw;
  } catch {
    // Fall through to the plain-text read.
  }
  return ctx.client.rci.getText('/rci/show/netfilter');
}

function summarise(tables: NetfilterTable[]): unknown {
  return tables.map(table => ({
    table: table.name,
    chains: table.chains.length,
    rules: table.chains.reduce((sum, chain) => sum + chain.rules.length, 0),
    // Built-in chains are the entry points; the rest are reached by jumps.
    builtIn: table.chains
      .filter(chain => /^[A-Z]+$/.test(chain.name))
      .map(chain => ({ chain: chain.name, policy: chain.policy, rules: chain.rules.length })),
    otherChains: table.chains
      .filter(chain => !/^[A-Z]+$/.test(chain.name))
      .map(chain => `${chain.name} (${String(chain.rules.length)})`)
  }));
}

export function registerNetfilterTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_netfilter',
    {
      title: 'Inspect the live packet filter',
      description:
        'The packet filter the router is actually running (`show netfilter`), parsed: the ' +
        'nat, filter and mangle tables, their chains and rules. Unlike get_firewall_rules, ' +
        'which shows what was configured, this shows what is in force - including the ' +
        'rules KeeneticOS generates itself for port forwarding, UPnP, KeenDNS and policies. ' +
        'With no arguments it returns a summary of tables and chains; give chain to read ' +
        'one chain, or search to find every rule mentioning a port, address, MAC or chain ' +
        'name. Interfaces are kernel names (br0, eth3, ppp0). The router prints no packet ' +
        'counters here, so this is the rule set, not hit counts.',
      inputSchema: {
        table: z.enum(['nat', 'filter', 'mangle']).optional().describe('Limit to one table.'),
        chain: z
          .string()
          .optional()
          .describe('Chain to list in full, e.g. PREROUTING, FORWARD or _NDM_DNAT.'),
        search: z
          .string()
          .optional()
          .describe('Case-insensitive text to find in rules: "dport: 8080", an IP, a MAC, DROP.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rules. Defaults to 100.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ table, chain, search, limit }): Promise<ToolResult> => {
      let tables = parseNetfilter(await readNetfilter(ctx));
      if (tables.length === 0) {
        return fail(
          new Error(
            'The router returned a netfilter listing this server could not parse. Read it raw ' +
              'with rci_call GET show/netfilter.'
          )
        );
      }
      if (table) tables = tables.filter(t => t.name === table);

      if (chain === undefined && (search === undefined || search.trim() === '')) {
        return ok({ tables: summarise(tables) }, ctx.maxResponseBytes);
      }

      const wantedChain = chain?.trim().toLowerCase();
      const needle = search?.trim().toLowerCase() ?? '';
      const rows: Array<{ table: string; chain: string; n: number; rule: string }> = [];
      const policies: Array<{ table: string; chain: string; policy: string | null }> = [];

      for (const t of tables) {
        for (const c of t.chains) {
          if (wantedChain !== undefined && c.name.toLowerCase() !== wantedChain) continue;
          if (wantedChain !== undefined) policies.push({ table: t.name, chain: c.name, policy: c.policy });
          c.rules.forEach((rule, index) => {
            const text = ruleText(rule);
            // The chain name is searchable too: "which rules are in SSH_IN".
            if (needle && !`${c.name} ${text}`.toLowerCase().includes(needle)) return;
            rows.push({ table: t.name, chain: c.name, n: index + 1, rule: text });
          });
        }
      }

      if (wantedChain !== undefined && policies.length === 0) {
        const known = tables.flatMap(t => t.chains.map(c => c.name));
        const close = known.filter(name => name.toLowerCase().includes(wantedChain)).slice(0, 15);
        return fail(
          new ValidationError(
            `No chain named "${chain ?? ''}".` +
              (close.length > 0 ? ` Similar: ${close.join(', ')}.` : '') +
              ' Call get_netfilter with no arguments for the list of chains.'
          )
        );
      }

      return listResult('rules', rows, limit ?? 100, ctx.maxResponseBytes, {
        ...(policies.length > 0 ? { chains: policies } : {})
      });
    })
  );
}
