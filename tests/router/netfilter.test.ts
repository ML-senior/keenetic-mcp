import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNetfilter, ruleText } from '../../src/router/netfilter.js';
import { registerNetfilterTools } from '../../src/tools/netfilter.js';
import { payload, rig, text } from '../helpers/harness.js';

// The shape of `show netfilter` on a KN-1810, KeeneticOS 5.2, with the
// addresses replaced by documentation ranges.
const LISTING = readFileSync(new URL('../fixtures/show_netfilter.txt', import.meta.url), 'utf8');

describe('parseNetfilter', () => {
  const tables = parseNetfilter(LISTING);
  const chain = (table: string, name: string) =>
    tables.find(t => t.name === table)!.chains.find(c => c.name === name)!;

  it('finds the three tables and their chains', () => {
    expect(tables.map(t => t.name)).toEqual(['nat', 'filter', 'mangle']);
    expect(tables[0]!.chains.map(c => c.name)).toEqual([
      'PREROUTING',
      'INPUT',
      'POSTROUTING',
      '_NDM_SNAT',
      '_NDM_DNAT'
    ]);
  });

  it('reads each chain policy', () => {
    expect(chain('nat', 'PREROUTING').policy).toBe('ACCEPT');
    expect(chain('filter', 'INPUT').policy).toBe('DROP');
    expect(chain('nat', '_NDM_DNAT').policy).toBe('RETURN');
  });

  it('keeps an empty chain', () => {
    expect(chain('nat', 'INPUT').rules).toEqual([]);
  });

  it('turns a jump into a target and names the chain it leads to', () => {
    expect(chain('nat', 'PREROUTING').rules[0]).toEqual({
      matches: [],
      target: 'jump:_NDM_DNAT',
      jump: '_NDM_DNAT'
    });
  });

  it('drops the match-anything defaults and keeps what narrows the rule', () => {
    const rule = chain('nat', 'PREROUTING').rules[3]!;
    expect(rule).toMatchObject({ dst: '198.51.100.11/32', proto: 'TCP' });
    expect('src' in rule).toBe(false);
    expect('in' in rule).toBe(false);
  });

  it('separates the matches from the target, commas and all', () => {
    const rule = chain('nat', '_NDM_DNAT').rules[0]!;
    expect(rule.matches).toEqual([
      '"tcp" match, mask: , cmp: , dport: 8443',
      '"ndmmark" match, value: 0x40/0x40, invert: 0x0'
    ]);
    expect(rule.target).toBe('DNAT, address: 192.0.2.13, port: 443');
  });

  it('keeps a target that itself contains punctuation', () => {
    expect(chain('filter', 'FORWARD').rules[1]!.target).toBe('TCPMSS, MSS: Clamp to PMTU');
    expect(chain('filter', 'INPUT').rules[1]!.matches).toEqual(['"state" match, state: ESTABLISHED, RELATED']);
  });

  it('reads kernel interface names', () => {
    expect(chain('nat', '_NDM_SNAT').rules[0]).toMatchObject({ out: 'eth3' });
    expect(chain('filter', 'FORWARD').rules[0]).toMatchObject({ in: 'br0' });
  });

  it('renders a rule as one searchable line', () => {
    expect(ruleText(chain('filter', 'SSH_IN').rules[0]!)).toBe(
      'TCP; "tcp" match, mask: , cmp: , dport: 22; "state" match, state: NEW; -> ACCEPT'
    );
  });

  it('survives the JSON-escaped form, CRLF and garbage', () => {
    expect(parseNetfilter(LISTING.replace(/\n/g, '\r\n'))).toEqual(tables);
    expect(parseNetfilter('')).toEqual([]);
    expect(parseNetfilter('not a listing at all')).toEqual([]);
  });
});

describe('get_netfilter', () => {
  const tool = (opts = {}) =>
    rig(registerNetfilterTools, { get: { 'show/netfilter': LISTING }, ...opts }).handlers['get_netfilter']!;

  it('summarises tables and chains when asked nothing', async () => {
    const out = payload(await tool()({}));
    expect(out.tables.map((t: any) => [t.table, t.chains, t.rules])).toEqual([
      ['nat', 5, 9],
      ['filter', 3, 6],
      ['mangle', 1, 1]
    ]);
    expect(out.tables[1].builtIn).toContainEqual({ chain: 'INPUT', policy: 'DROP', rules: 3 });
    expect(out.tables[0].otherChains).toContain('_NDM_DNAT (2)');
  });

  it('lists one chain in order, with its policy', async () => {
    const out = payload(await tool()({ chain: '_ndm_dnat' }));
    expect(out.chains).toEqual([{ table: 'nat', chain: '_NDM_DNAT', policy: 'RETURN' }]);
    expect(out.rules.map((r: any) => r.n)).toEqual([1, 2]);
    expect(out.rules[1].rule).toContain('DNAT, address: 192.0.2.10');
  });

  it('tells the same chain name in two tables apart', async () => {
    const out = payload(await tool()({ chain: 'PREROUTING' }));
    expect(out.chains.map((c: any) => c.table)).toEqual(['nat', 'mangle']);
    expect(payload(await tool()({ chain: 'PREROUTING', table: 'mangle' })).total).toBe(1);
  });

  it('finds every rule mentioning a port', async () => {
    const out = payload(await tool()({ search: 'dport: 8443' }));
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0]).toMatchObject({ table: 'nat', chain: '_NDM_DNAT' });
  });

  it('finds rules by MAC, by verdict and by chain name', async () => {
    expect(payload(await tool()({ search: '02:00:00:00:00:21' })).total).toBe(1);
    expect(payload(await tool()({ search: 'drop' })).total).toBe(1);
    expect(payload(await tool()({ search: 'ssh_in' })).total).toBe(2);
  });

  it('suggests chains when the name is wrong', async () => {
    const result = await tool()({ chain: 'DNAT' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('_NDM_DNAT');
  });

  it('falls back to the text endpoint when the JSON read fails', async () => {
    const r = rig(registerNetfilterTools, { get: {}, getText: () => LISTING });
    const out = payload(await r.handlers['get_netfilter']!({}));
    expect(out.tables).toHaveLength(3);
    expect(r.getText).toHaveBeenCalledWith('/rci/show/netfilter');
  });

  it('holds a long chain to the limit and says so', async () => {
    const out = payload(await tool()({ search: 'match', limit: 3 }));
    expect(out.rules).toHaveLength(3);
    expect(out.total).toBeGreaterThan(3);
    expect(out.note).toMatch(/Showing 3 of/);
  });
});
