/**
 * `show netfilter` as data.
 *
 * The router prints its packet filter as prose, one rule per line:
 *
 *   ==== Table: "nat" ====
 *   == Chain PREROUTING ==
 *   src: 0.0.0.0/0, dst: 0.0.0.0/0, in: "*", out: "*", proto: "TCP"; "tcp" match, mask: , cmp: , dport: 8080; jump to "_NDM_DNAT"
 *   -> Chain default policy: ACCEPT
 *
 * About 40 KB of it on a home router (measured on a KN-1810, KeeneticOS 5.2:
 * three tables, 93 chains), which is more than a response may carry and far
 * more than anyone asks about at once. Parsed, it can be summarised, narrowed
 * to one chain, or searched.
 *
 * The listing carries no packet or byte counters - the router does not print
 * them here - so this is the rule set, not its hit counts.
 */
export interface NetfilterRule {
  /** Omitted when the rule matches any address, which is nearly always. */
  src?: string;
  dst?: string;
  /** Kernel interface names (br0, eth3, ppp0), not KeeneticOS ones. */
  in?: string;
  out?: string;
  proto?: string;
  /** The match clauses between the header and the target, as the router wrote them. */
  matches: string[];
  /** ACCEPT, DROP, RETURN, `DNAT, address: ...`, or `jump:<chain>`. */
  target: string;
  /** The chain a `jump to` rule leads to. */
  jump?: string;
}

export interface NetfilterChain {
  name: string;
  /** The default policy; user-defined chains report RETURN. */
  policy: string | null;
  rules: NetfilterRule[];
}

export interface NetfilterTable {
  name: string;
  chains: NetfilterChain[];
}

const TABLE = /^====\s*Table:\s*"?([^"=]+?)"?\s*====$/;
const CHAIN = /^==\s*Chain\s+(.+?)\s*==$/;
const POLICY = /^->\s*Chain default policy:\s*(\S+)/;
const JUMP = /^jump to "([^"]*)"$/;

const ANY_ADDRESS = '0.0.0.0/0';

/** `src: A, dst: B, in: "x", out: "y", proto: "P"` into its five fields. */
function parseHeader(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of header.split(',')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    fields[key] = part.slice(colon + 1).trim().replace(/^"|"$/g, '');
  }
  return fields;
}

function parseRule(line: string): NetfilterRule {
  // Clauses are separated by "; " - and a clause never contains one, though it
  // does contain commas, which is why the header is split separately.
  const clauses = line.split(/;\s+/).map(clause => clause.trim()).filter(Boolean);
  const header = parseHeader(clauses[0] ?? '');
  const last = clauses.length > 1 ? (clauses[clauses.length - 1] as string) : '';
  const jump = JUMP.exec(last)?.[1];

  const rule: NetfilterRule = {
    matches: clauses.slice(1, -1),
    target: jump !== undefined ? `jump:${jump}` : last
  };
  if (jump !== undefined) rule.jump = jump;
  // Defaults are dropped: with 250 rules, six words of "matches anything" each
  // is most of the response.
  if (header['src'] && header['src'] !== ANY_ADDRESS) rule.src = header['src'];
  if (header['dst'] && header['dst'] !== ANY_ADDRESS) rule.dst = header['dst'];
  if (header['in'] && header['in'] !== '*') rule.in = header['in'];
  if (header['out'] && header['out'] !== '*') rule.out = header['out'];
  if (header['proto'] && header['proto'].toLowerCase() !== 'any') rule.proto = header['proto'];
  return rule;
}

export function parseNetfilter(text: string): NetfilterTable[] {
  const tables: NetfilterTable[] = [];
  let table: NetfilterTable | null = null;
  let chain: NetfilterChain | null = null;

  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    const tableName = TABLE.exec(line)?.[1];
    if (tableName !== undefined) {
      table = { name: tableName, chains: [] };
      tables.push(table);
      chain = null;
      continue;
    }
    const chainName = CHAIN.exec(line)?.[1];
    if (chainName !== undefined) {
      // A chain before any table header would be a format this does not know;
      // keep it rather than drop it, under a table that says so.
      if (!table) {
        table = { name: 'unknown', chains: [] };
        tables.push(table);
      }
      chain = { name: chainName, policy: null, rules: [] };
      table.chains.push(chain);
      continue;
    }
    if (!chain) continue;

    const policy = POLICY.exec(line)?.[1];
    if (policy !== undefined) {
      chain.policy = policy;
      continue;
    }
    if (line.startsWith('src:')) chain.rules.push(parseRule(line));
  }
  return tables;
}

/** The rule as one readable line, for search and for compact output. */
export function ruleText(rule: NetfilterRule): string {
  const head = [
    rule.proto,
    rule.src && `src ${rule.src}`,
    rule.dst && `dst ${rule.dst}`,
    rule.in && `in ${rule.in}`,
    rule.out && `out ${rule.out}`
  ].filter(Boolean);
  return [...head, ...rule.matches, `-> ${rule.target}`].join('; ');
}
