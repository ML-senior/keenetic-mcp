import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}

/**
 * A config branch with one surviving record often comes back as a bare object
 * instead of a one-element array - the router unwraps it. Normalize both.
 */
function asEntries(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'object' && v !== null) as Row[];
  if (typeof value === 'object' && value !== null) return [value as Row];
  return [];
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/** KeeneticOS caps static `ip host` records at 64 (command reference). */
const DNS_HOST_LIMIT = 64;

function normMac(value: string): string {
  const mac = value.trim().toLowerCase().replace(/-/g, ':');
  if (!MAC_RE.test(mac)) {
    throw new Error(`'${value}' is not a MAC address (expected aa:bb:cc:dd:ee:ff).`);
  }
  return mac;
}

function normDomain(value: string): string {
  const domain = value.trim().replace(/\.$/, '').toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`'${value}' is not a valid domain name.`);
  }
  return domain;
}

function checkPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`port ${String(value)} is out of range (1-65535).`);
  }
  return value;
}

/**
 * Port forwarding targets a MAC, never an IP. Accept either and resolve,
 * refusing hosts the router does not know - a typo would otherwise create a
 * rule that silently forwards nowhere.
 */
async function resolveToHost(ctx: ToolContext, value: string): Promise<string> {
  const cleaned = value.trim().toLowerCase();
  if (MAC_RE.test(cleaned.replace(/-/g, ':'))) return normMac(cleaned);
  if (!IP_RE.test(cleaned)) {
    throw new Error(`'${value}' is neither a MAC nor an IPv4 address.`);
  }
  const dhcp = asEntries(await ctx.client.rci.get('ip/dhcp/host'));
  for (const entry of dhcp) {
    if (entry['ip'] === cleaned && typeof entry['mac'] === 'string') return normMac(entry['mac']);
  }
  const hotspot = asRecord(await ctx.client.rci.get('show/ip/hotspot'));
  for (const host of asEntries(hotspot['host'])) {
    if (host['ip'] === cleaned && typeof host['mac'] === 'string') return normMac(host['mac']);
  }
  throw new Error(
    `No registered host has IP ${cleaned}. Register it first with update_device ` +
      '(supplying name registers), or pass the MAC explicitly.'
  );
}

function shapeStaticRule(rule: Row): Row {
  return {
    index: rule['index'] ?? null,
    protocol: rule['protocol'] ?? null,
    interface: rule['interface'] ?? null,
    port: rule['port'] ?? null,
    endPort: rule['end-port'] ?? null,
    toHost: rule['to-host'] ?? null,
    toPort: rule['to-port'] ?? null,
    comment: rule['comment'] ?? null,
    disabled: rule['disable'] === true
  };
}

async function fetchStaticRules(ctx: ToolContext): Promise<Row[]> {
  return asEntries(await ctx.client.rci.get('ip/static'));
}

export function registerServiceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_port_forwarding',
    {
      title: 'List port forwarding rules',
      description:
        'Static NAT / port forwarding rules (the `ip static` config tree): external port, ' +
        'protocol, target host and interface. Targets are MAC addresses - resolve them to ' +
        'names with list_devices if needed.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const rules = (await fetchStaticRules(ctx)).map(shapeStaticRule);
      return ok({ rules, total: rules.length });
    })
  );

  server.registerTool(
    'get_keendns_mappings',
    {
      title: 'List KeenDNS mappings',
      description:
        'KeenDNS web-application access mappings (the `ip http proxy` config tree): which ' +
        'fourth-level name is published and which upstream host:port it proxies to.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const tree = asRecord(await ctx.client.rci.get('ip/http/proxy'));
      const mappings = Object.entries(tree).map(([name, value]) => {
        const entry = asRecord(value);
        const upstream = asRecord(entry['upstream']);
        return {
          name,
          upstream: upstream['upstream'] ?? null,
          port: upstream['port'] ?? null,
          proto: upstream['proto'] ?? null,
          sslRedirect: asRecord(entry['ssl'])['redirect'] === true,
          securityLevel: Object.keys(asRecord(entry['security-level'])).join(',') || null
        };
      });
      return ok({ mappings, total: mappings.length });
    })
  );

  server.registerTool(
    'get_dns_records',
    {
      title: 'List static DNS records',
      description:
        'Static DNS records served by the router itself (the `ip host` config tree): ' +
        'domain to IPv4 address. This is the LAN half of a split-horizon setup.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const records = asEntries(await ctx.client.rci.get('ip/host')).map(h => ({
        domain: h['domain'] ?? null,
        address: h['address'] ?? null
      }));
      return ok({ records, total: records.length, limit: DNS_HOST_LIMIT });
    })
  );

  server.registerTool(
    'get_dhcp_static',
    {
      title: 'List static DHCP reservations',
      description:
        'Fixed MAC-to-IP bindings (the `ip dhcp host` config tree). A device with a ' +
        'reservation never appears as a pool lease, so check here when an IP seems ' +
        'assigned without a lease.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const hosts = asEntries(await ctx.client.rci.get('ip/dhcp/host')).map(h => ({
        mac: h['mac'] ?? null,
        ip: h['ip'] ?? null
      }));
      return ok({ reservations: hosts, total: hosts.length });
    })
  );

  server.registerTool(
    'get_firewall_rules',
    {
      title: 'List firewall rules',
      description:
        'Firewall configuration parsed from the running config: access-lists with their ' +
        'permit/deny entries, `ip firewall` settings and interface `ip access-group` ' +
        'bindings. Read-only; there is no write tool for firewall rules.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const text = await ctx.client.rci.getText('/ci/running-config.txt');
      const lines = text.split('\n');

      const accessLists: Array<{ name: string; rules: string[] }> = [];
      const ipFirewall: string[] = [];
      const accessGroups: string[] = [];
      let current: { name: string; rules: string[] } | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        const indented = line !== trimmed;
        // access-group bindings live inside interface blocks, so indentation
        // does not rule them out.
        if (trimmed.startsWith('ip access-group ')) {
          accessGroups.push(trimmed);
          continue;
        }
        if (!indented) {
          current = null;
          if (trimmed.startsWith('access-list ')) {
            current = { name: trimmed.slice('access-list '.length), rules: [] };
            accessLists.push(current);
          } else if (trimmed.startsWith('ip firewall ')) {
            ipFirewall.push(trimmed);
          }
        } else if (current && (trimmed.startsWith('permit ') || trimmed.startsWith('deny '))) {
          current.rules.push(trimmed);
        }
      }

      return ok({ accessLists, ipFirewall, accessGroups });
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'set_port_forwarding',
    {
      title: 'Create or update a port forwarding rule',
      description:
        'Forwards an external TCP/UDP port to a device. The target is addressed by MAC: ' +
        'pass to_host as a MAC, or as the IP of a device the router already knows - an ' +
        'unknown IP is refused. Changes apply immediately but are NOT saved until ' +
        'save_config is called.',
      inputSchema: {
        to_host: z.string().describe('Target device: MAC address, or IP of a known device.'),
        port: z.number().int().min(1).max(65535).describe('External port.'),
        protocol: z.enum(['tcp', 'udp']).optional().describe('Defaults to tcp.'),
        interface: z
          .string()
          .optional()
          .describe('WAN interface the rule listens on. Defaults to GigabitEthernet1.'),
        to_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Internal port, when it differs from the external one.'),
        end_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('End of the external port range, for forwarding a range.'),
        comment: z.string().optional().describe('Free-form comment.'),
        enable: z
          .boolean()
          .optional()
          .describe('false creates the rule disabled. Defaults to enabled.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ to_host, port, protocol, interface: iface, to_port, end_port, comment, enable }): Promise<ToolResult> => {
      const proto = protocol ?? 'tcp';
      const wan = iface ?? 'GigabitEthernet1';
      const mac = await resolveToHost(ctx, to_host);
      checkPort(port);
      if (to_port !== undefined) checkPort(to_port);
      if (end_port !== undefined) checkPort(end_port);

      const snapshot = await ctx.backup.ensure();

      const rule: Row = {
        interface: wan,
        protocol: proto,
        port: String(port),
        'to-host': mac
      };
      if (to_port !== undefined) rule['to-port'] = String(to_port);
      if (end_port !== undefined) rule['end-port'] = String(end_port);
      if (comment !== undefined) rule['comment'] = comment;
      // `disable` is a per-rule attribute; clearing it uses the attribute-removal form.
      rule['disable'] = enable === false ? true : { no: true };

      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { static: rule } }),
        readBack: () => fetchStaticRules(ctx),
        check: rules =>
          rules.some(r => r['protocol'] === proto && r['port'] === String(port) && r['to-host'] === mac),
        what: `forward ${proto}/${String(port)} -> ${mac}`
      });

      return ok(
        describeWrite(
          { portForwarding: `${proto}/${String(port)} on ${wan} -> ${mac}${to_port ? `:${String(to_port)}` : ''}` },
          snapshot.path
        )
      );
    })
  );

  server.registerTool(
    'remove_port_forwarding',
    {
      title: 'Remove a port forwarding rule',
      description:
        'Deletes one `ip static` rule, addressed by its index (from get_port_forwarding) ' +
        'or by external port and protocol. Ambiguous matches are refused rather than ' +
        'guessed. NOT saved until save_config is called.',
      inputSchema: {
        index: z.string().optional().describe('Rule index from get_port_forwarding.'),
        port: z.number().int().min(1).max(65535).optional().describe('External port.'),
        protocol: z.enum(['tcp', 'udp']).optional().describe('Narrows a port match.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ index, port, protocol }): Promise<ToolResult> => {
      const rules = await fetchStaticRules(ctx);
      let matches: Row[] = [];
      if (index !== undefined) {
        matches = rules.filter(r => r['index'] === index);
      } else if (port !== undefined) {
        matches = rules.filter(
          r => r['port'] === String(port) && (protocol === undefined || r['protocol'] === protocol)
        );
      } else {
        return fail(new Error('Supply index or port (see get_port_forwarding).'));
      }

      if (matches.length === 0) {
        return fail(new Error('No matching rule. Call get_port_forwarding for the current list.'));
      }
      if (matches.length > 1) {
        return fail(
          new Error(
            `${String(matches.length)} rules match - narrow it down with index: ` +
              JSON.stringify(matches.map(shapeStaticRule))
          )
        );
      }

      const rule = matches[0]!;
      const snapshot = await ctx.backup.ensure();

      const payloadRule: Row = {};
      for (const [key, value] of Object.entries(rule)) {
        if (key !== 'disable') payloadRule[key] = value;
      }
      payloadRule['no'] = true;

      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { static: payloadRule } }),
        readBack: () => fetchStaticRules(ctx),
        check: after => !after.some(r => r['index'] === rule['index']),
        what: `remove rule ${String(rule['index'])}`
      });

      return ok(
        describeWrite(
          { removed: `${String(rule['protocol'])}/${String(rule['port'])} -> ${String(rule['to-host'])}` },
          snapshot.path
        )
      );
    })
  );

  server.registerTool(
    'set_keendns_mapping',
    {
      title: 'Publish a web app via KeenDNS',
      description:
        'Creates or updates an `ip http proxy` mapping: a fourth-level KeenDNS name that ' +
        'proxies to an upstream host:port, with HTTPS redirect. NOT saved until ' +
        'save_config is called.',
      inputSchema: {
        name: z.string().describe('Mapping name (the KeenDNS fourth-level name).'),
        host: z.string().describe('Upstream host: IP, MAC or 127.0.0.1.'),
        port: z.number().int().min(1).max(65535).describe('Upstream port.'),
        proto: z.enum(['http', 'https']).optional().describe('Upstream protocol. Defaults to http.'),
        security_level: z
          .enum(['public', 'private'])
          .optional()
          .describe('public is open to the internet; private asks for router credentials. Defaults to public.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ name, host, port, proto, security_level }): Promise<ToolResult> => {
      if (!name.trim()) return fail(new Error('name is required.'));
      if (!host.trim()) return fail(new Error('host is required (IP, MAC or 127.0.0.1).'));
      checkPort(port);
      const upstreamProto = proto ?? 'http';
      const level = security_level ?? 'public';

      const snapshot = await ctx.backup.ensure();

      const entry = {
        upstream: { proto: upstreamProto, upstream: host, port: String(port) },
        domain: { ndns: true },
        ssl: { redirect: true },
        'security-level': { [level]: true }
      };

      const expected = `${upstreamProto}://${host}:${String(port)}`;
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { http: { proxy: { [name]: entry } } } }),
        readBack: async () => asRecord(await ctx.client.rci.get('ip/http/proxy')),
        check: tree => {
          const up = asRecord(asRecord(tree[name])['upstream']);
          return `${String(up['proto'])}://${String(up['upstream'])}:${String(up['port'])}` === expected;
        },
        what: `KeenDNS '${name}' -> ${expected}`
      });

      return ok(describeWrite({ keendnsMapping: `${name} -> ${expected} (${level})` }, snapshot.path));
    })
  );

  server.registerTool(
    'remove_keendns_mapping',
    {
      title: 'Remove a KeenDNS mapping',
      description:
        'Deletes one `ip http proxy` entry, so the name stops being reachable from the ' +
        'internet. NOT saved until save_config is called.',
      inputSchema: {
        name: z.string().describe('Mapping name from get_keendns_mappings.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ name }): Promise<ToolResult> => {
      const existing = asRecord(await ctx.client.rci.get('ip/http/proxy'));
      if (!(name in existing)) {
        return fail(
          new Error(
            `No KeenDNS mapping named '${name}'. Existing: ${Object.keys(existing).join(', ') || 'none'}.`
          )
        );
      }

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { http: { proxy: { [name]: { no: true } } } } }),
        readBack: async () => asRecord(await ctx.client.rci.get('ip/http/proxy')),
        check: tree => !(name in tree),
        what: `remove KeenDNS mapping '${name}'`
      });

      return ok(describeWrite({ removed: name }, snapshot.path));
    })
  );

  server.registerTool(
    'set_dns_host',
    {
      title: 'Add a static DNS record',
      description:
        'Adds `ip host <domain> <address>`, served by the router itself. `ip host` allows ' +
        'several addresses per name and round-robins them, so a name that already resolves ' +
        'elsewhere is REFUSED rather than extended - remove the old record first. ' +
        'NOT saved until save_config is called.',
      inputSchema: {
        domain: z.string().describe('The name to resolve.'),
        address: z.string().describe('IPv4 address it should resolve to.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    guard(async ({ domain, address }): Promise<ToolResult> => {
      const name = normDomain(domain);
      if (!IP_RE.test(address)) return fail(new Error(`'${address}' is not an IPv4 address.`));

      const hosts = asEntries(await ctx.client.rci.get('ip/host'));
      const sameName = hosts.filter(
        h =>
          typeof h['domain'] === 'string' &&
          h['domain'].trim().replace(/\.$/, '').toLowerCase() === name
      );
      if (sameName.length > 0 && !sameName.some(h => h['address'] === address)) {
        return fail(
          new Error(
            `${name} already resolves to ${sameName.map(h => String(h['address'])).join(', ')}. ` +
              'Writing another address would load-balance the name instead of moving it. ' +
              'Remove the old record first with remove_dns_host.'
          )
        );
      }
      if (sameName.length === 0 && hosts.length >= DNS_HOST_LIMIT) {
        return fail(
          new Error(`The router already holds ${String(hosts.length)} static DNS records; the documented limit is ${String(DNS_HOST_LIMIT)}.`)
        );
      }

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { host: { domain: name, address } } }),
        readBack: async () => asEntries(await ctx.client.rci.get('ip/host')),
        check: after =>
          after.some(
            e =>
              typeof e['domain'] === 'string' &&
              e['domain'].trim().replace(/\.$/, '').toLowerCase() === name &&
              e['address'] === address
          ),
        what: `static DNS ${name} -> ${address}`
      });

      return ok(describeWrite({ dnsRecord: `${name} -> ${address}` }, snapshot.path));
    })
  );

  server.registerTool(
    'remove_dns_host',
    {
      title: 'Remove a static DNS record',
      description:
        'Deletes `ip host <domain> <address>`. The router needs the address in the removal ' +
        'command, so a name holding several addresses must be narrowed down with the ' +
        'address argument. NOT saved until save_config is called.',
      inputSchema: {
        domain: z.string().describe('The record name.'),
        address: z.string().optional().describe('Which address, when the name holds several.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ domain, address }): Promise<ToolResult> => {
      const name = normDomain(domain);
      let matches = asEntries(await ctx.client.rci.get('ip/host')).filter(
        h =>
          typeof h['domain'] === 'string' &&
          h['domain'].trim().replace(/\.$/, '').toLowerCase() === name
      );
      if (address) matches = matches.filter(h => h['address'] === address);

      if (matches.length === 0) {
        return fail(new Error(`No static DNS record for ${name}${address ? ` -> ${address}` : ''}.`));
      }
      if (matches.length > 1) {
        return fail(
          new Error(
            `${String(matches.length)} records for ${name} (${matches.map(h => String(h['address'])).join(', ')}) - ` +
              'name the address to pick one.'
          )
        );
      }
      const record = matches[0]!;

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () =>
          ctx.client.rci.post({
            ip: { host: { domain: record['domain'], address: record['address'], no: true } }
          }),
        readBack: async () => asEntries(await ctx.client.rci.get('ip/host')),
        check: after =>
          !after.some(
            e => e['domain'] === record['domain'] && e['address'] === record['address']
          ),
        what: `remove static DNS ${String(record['domain'])}`
      });

      return ok(
        describeWrite({ removed: `${String(record['domain'])} -> ${String(record['address'])}` }, snapshot.path)
      );
    })
  );

  server.registerTool(
    'set_dhcp_host',
    {
      title: 'Reserve a static DHCP address',
      description:
        'Binds a MAC to a fixed IP (`ip dhcp host`). An IP already reserved for a ' +
        'different MAC is refused. The device NAME lives elsewhere - use update_device ' +
        'for that. NOT saved until save_config is called.',
      inputSchema: {
        mac: z.string().describe('Device MAC address, any case.'),
        ip: z.string().describe('IPv4 address to reserve for it.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ mac, ip }): Promise<ToolResult> => {
      const normalizedMac = normMac(mac);
      if (!IP_RE.test(ip)) return fail(new Error(`'${ip}' is not an IPv4 address.`));

      const existing = asEntries(await ctx.client.rci.get('ip/dhcp/host'));
      const conflict = existing.find(e => e['ip'] === ip && e['mac'] !== normalizedMac);
      if (conflict) {
        return fail(
          new Error(`${ip} is already reserved for ${String(conflict['mac'])}. Free it first with remove_dhcp_host.`)
        );
      }

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { dhcp: { host: { mac: normalizedMac, ip } } } }),
        readBack: async () => asEntries(await ctx.client.rci.get('ip/dhcp/host')),
        check: after => after.some(e => e['mac'] === normalizedMac && e['ip'] === ip),
        what: `reserve ${ip} for ${normalizedMac}`
      });

      return ok(describeWrite({ dhcpReservation: `${normalizedMac} -> ${ip}` }, snapshot.path));
    })
  );

  server.registerTool(
    'remove_dhcp_host',
    {
      title: 'Remove a static DHCP reservation',
      description:
        'Deletes the `ip dhcp host` binding for a MAC. The device falls back to a pool ' +
        'address on its next lease. NOT saved until save_config is called.',
      inputSchema: {
        mac: z.string().describe('MAC address of the reservation to remove.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ mac }): Promise<ToolResult> => {
      const normalizedMac = normMac(mac);
      const existing = asEntries(await ctx.client.rci.get('ip/dhcp/host'));
      const match = existing.find(e => e['mac'] === normalizedMac);
      if (!match) {
        return fail(new Error(`No static DHCP reservation for ${normalizedMac}.`));
      }

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => ctx.client.rci.post({ ip: { dhcp: { host: { mac: normalizedMac, no: true } } } }),
        readBack: async () => asEntries(await ctx.client.rci.get('ip/dhcp/host')),
        check: after => !after.some(e => e['mac'] === normalizedMac),
        what: `remove reservation for ${normalizedMac}`
      });

      return ok(describeWrite({ removed: `${normalizedMac} (${String(match['ip'])})` }, snapshot.path));
    })
  );
}
