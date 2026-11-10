import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { cliWord, runCli } from '../router/cli.js';
import { ValidationError } from '../router/errors.js';
import { asEntries, asRecord, numOrNull, str, type Row } from '../shape/coerce.js';
import { isIPv4 } from '../shape/validate.js';
import { fail, guard, ok, READ_ONLY, WRITE, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

/** A WireGuard key: 32 bytes, base64 - 43 characters and one `=`. */
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const INTERFACE_RE = /^Wireguard\d+$/;

function checkKey(value: string, what: string): string {
  const key = value.trim();
  if (!KEY_RE.test(key)) {
    throw new ValidationError(
      `${what} is not a WireGuard key. It should be 44 base64 characters ending in "=".`
    );
  }
  return key;
}

function checkInterface(value: string): string {
  const name = value.trim();
  if (!INTERFACE_RE.test(name)) {
    throw new ValidationError(
      `"${value}" is not a WireGuard interface id. Expected the form Wireguard0; ` +
        'call list_wireguard_peers to see the ones on this router.'
    );
  }
  return name;
}

/** `192.0.2.2/32` or `0.0.0.0/0` into the address-and-mask pair the CLI takes. */
export function cidrToAddressMask(cidr: string): { address: string; mask: string } {
  const [address = '', prefixRaw = '32'] = cidr.trim().split('/');
  const prefix = Number(prefixRaw);
  if (!isIPv4(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new ValidationError(
      `"${cidr}" is not an IPv4 network. Write it as 192.0.2.2/32, 198.51.100.0/24 or 0.0.0.0/0.`
    );
  }
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const mask = [24, 16, 8, 0].map(shift => String((bits >>> shift) & 0xff)).join('.');
  return { address, mask };
}

/** The peers in a WireGuard interface's configuration, whatever shape it came in. */
function configPeers(config: Row): Row[] {
  return asEntries(asRecord(config['wireguard'])['peer']);
}

async function readConfig(ctx: ToolContext, name: string): Promise<Row> {
  return asRecord(await ctx.client.rci.get(`show/rc/interface/${name}`));
}

const peerKey = (peer: Row): string => str(peer, 'key') || str(peer, 'public-key');

/** Preshared keys are secrets; a listing says only that one is set. */
function redactPeer(peer: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(peer)) {
    out[key] = /preshared|psk|private/i.test(key) ? '<set>' : value;
  }
  return out;
}

export function registerWireguardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_wireguard_peers',
    {
      title: 'List WireGuard tunnels and peers',
      description:
        'Every WireGuard interface with its address, listen port and state, and for each ' +
        'peer the public key, endpoint, allowed networks, traffic and time since the last ' +
        'handshake. A peer with no recent handshake is not connected, whatever the ' +
        'interface state says. Private and preshared keys are never returned.',
      inputSchema: {
        interface: z.string().optional().describe('One interface, e.g. Wireguard0. Defaults to all.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ interface: only }): Promise<ToolResult> => {
      const all = asRecord(await ctx.client.rci.get('show/interface'));
      const wanted = only ? checkInterface(only) : null;

      const tunnels = Object.entries(all)
        .filter(([id, value]) => asRecord(value)['type'] === 'Wireguard' && (!wanted || id === wanted))
        .map(([id, value]) => {
          const record = asRecord(value);
          const wg = asRecord(record['wireguard']);
          return {
            interface: id,
            description: str(record, 'description'),
            state: str(record, 'state'),
            link: str(record, 'link'),
            address: str(record, 'address') || null,
            publicKey: str(wg, 'public-key') || null,
            listenPort: numOrNull(wg['listen-port']),
            peers: asEntries(wg['peer']).map(redactPeer)
          };
        });

      if (wanted && tunnels.length === 0) {
        return fail(new ValidationError(`There is no WireGuard interface "${wanted}" on this router.`));
      }
      return ok(
        {
          tunnels,
          total: tunnels.length,
          ...(tunnels.length === 0
            ? { note: 'This router has no WireGuard interfaces. Create one in the web interface first.' }
            : {})
        },
        ctx.maxResponseBytes
      );
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'set_wireguard_peer',
    {
      title: 'Add or update a WireGuard peer',
      description:
        'Adds a peer to an existing WireGuard interface, or changes one that is already ' +
        'there, identified by its public key. Only the settings you pass are touched. ' +
        'allowed_ips given here are ADDED to what the peer already has. The interface ' +
        'itself and its private key are not created here. Applies at once; NOT saved until ' +
        'save_config. Changing the peer that carries this very connection can cut it off.',
      inputSchema: {
        interface: z.string().describe('WireGuard interface id, e.g. Wireguard0.'),
        public_key: z.string().describe("The peer's public key (44 base64 characters)."),
        endpoint: z
          .string()
          .optional()
          .describe('Where to reach the peer, host:port. Omit for a peer that connects to us.'),
        allowed_ips: z
          .array(z.string())
          .optional()
          .describe('Networks routed to this peer, as CIDR: ["192.0.2.2/32"] or ["0.0.0.0/0"].'),
        keepalive_sec: z
          .number()
          .int()
          .min(0)
          .max(65535)
          .optional()
          .describe('Persistent keepalive in seconds; 25 keeps a NAT mapping open. 0 turns it off.'),
        preshared_key: z.string().optional().describe('Optional preshared key (44 base64 characters).'),
        comment: z.string().optional().describe('A one-word label for the peer.')
      },
      annotations: WRITE
    },
    guard(
      async ({
        interface: rawName,
        public_key,
        endpoint,
        allowed_ips,
        keepalive_sec,
        preshared_key,
        comment
      }): Promise<ToolResult> => {
        const name = checkInterface(rawName);
        const key = checkKey(public_key, 'public_key');
        const peer = `interface ${name} wireguard peer ${key}`;

        // Every argument is validated before the first line is sent, so a bad
        // one cannot leave the peer half-configured.
        const lines: string[] = [peer];
        if (endpoint !== undefined) lines.push(`${peer} endpoint ${cliWord(endpoint, 'endpoint')}`);
        for (const cidr of allowed_ips ?? []) {
          const { address, mask } = cidrToAddressMask(cidr);
          lines.push(`${peer} allow-ips ${address} ${mask}`);
        }
        if (keepalive_sec !== undefined) {
          lines.push(
            keepalive_sec === 0
              ? `${peer} no keepalive-interval`
              : `${peer} keepalive-interval ${String(keepalive_sec)}`
          );
        }
        if (preshared_key !== undefined) {
          lines.push(`${peer} preshared-key ${checkKey(preshared_key, 'preshared_key')}`);
        }
        if (comment !== undefined) lines.push(`${peer} comment ${cliWord(comment, 'comment')}`);

        // Reading the configuration first proves the interface exists: the
        // CLI would otherwise create one named by a typo.
        let before: Row;
        try {
          before = await readConfig(ctx, name);
        } catch {
          return fail(
            new ValidationError(
              `There is no WireGuard interface "${name}" on this router. This tool adds peers to ` +
                'an existing interface; it does not create one.'
            )
          );
        }
        const existed = configPeers(before).some(p => peerKey(p) === key);

        const snapshot = await ctx.backup.ensure();
        const after = await verifiedWrite({
          apply: async () => {
            for (const line of lines) await runCli(ctx.client.rci, line);
          },
          readBack: () => readConfig(ctx, name),
          check: config => configPeers(config).some(p => peerKey(p) === key),
          what: `peer ${key.slice(0, 8)}… on ${name}`
        });

        const stored = configPeers(after).find(p => peerKey(p) === key);
        return ok({
          ...describeWrite({ interface: name, peer: key, action: existed ? 'updated' : 'added' }, snapshot.path),
          // The peer as the router now holds it: the presence of the peer is
          // verified above, and this is where to check each setting landed.
          peer: stored ? redactPeer(stored) : null
        });
      }
    )
  );

  server.registerTool(
    'remove_wireguard_peer',
    {
      title: 'Remove a WireGuard peer',
      description:
        'Deletes one peer from a WireGuard interface by its public key; the device behind ' +
        'it loses the tunnel at once. The interface and its other peers are untouched. To ' +
        'remove the whole tunnel use delete_interface. NOT saved until save_config.',
      inputSchema: {
        interface: z.string().describe('WireGuard interface id, e.g. Wireguard0.'),
        public_key: z.string().describe("The peer's public key, from list_wireguard_peers.")
      },
      annotations: WRITE
    },
    guard(async ({ interface: rawName, public_key }): Promise<ToolResult> => {
      const name = checkInterface(rawName);
      const key = checkKey(public_key, 'public_key');

      let config: Row;
      try {
        config = await readConfig(ctx, name);
      } catch {
        return fail(new ValidationError(`There is no WireGuard interface "${name}" on this router.`));
      }
      const peers = configPeers(config);
      if (!peers.some(p => peerKey(p) === key)) {
        return fail(
          new ValidationError(
            `${name} has no peer with that public key. It has ${String(peers.length)} peer(s); ` +
              'call list_wireguard_peers to see their keys.'
          )
        );
      }

      const snapshot = await ctx.backup.ensure();
      await verifiedWrite({
        apply: () => runCli(ctx.client.rci, `interface ${name} no wireguard peer ${key}`),
        readBack: () => readConfig(ctx, name),
        check: after => !configPeers(after).some(p => peerKey(p) === key),
        what: `removal of peer ${key.slice(0, 8)}… from ${name}`
      });

      return ok(describeWrite({ interface: name, removedPeer: key }, snapshot.path));
    })
  );
}
