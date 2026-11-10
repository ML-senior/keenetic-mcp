import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { cliWord, runCli } from '../router/cli.js';
import type { KeeneticClient } from '../router/client.js';
import { ValidationError } from '../router/errors.js';
import { asEntries, asRecord, str, type Row } from '../shape/coerce.js';
import { isMac, normMac } from '../shape/validate.js';
import { isReadOnlyBody } from './raw.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

/** Routers waiting to be adopted, in whatever container the firmware used. */
function candidatesOf(raw: unknown): Row[] {
  const root = asRecord(raw);
  const list = root['candidate'] ?? root['candidates'];
  if (list !== undefined) return asEntries(list);
  // No wrapper key: either nothing at all, or a map of id -> record.
  return Object.values(root).flatMap(value => asEntries(value));
}

const candidateId = (c: Row): string => str(c, 'mac') || str(c, 'cid') || str(c, 'id');

interface MeshNode {
  name: string;
  mac: string;
  ip: string;
}

/** The extenders the controller itself lists - the only hosts a node call may reach. */
async function meshNodes(ctx: ToolContext): Promise<MeshNode[]> {
  const hotspot = asRecord(await ctx.client.rci.get('show/ip/hotspot'));
  return asEntries(hotspot['host'])
    .filter(h => typeof h['system-mode'] === 'string' && h['system-mode'] !== '')
    .map(h => ({ name: str(h, 'name') || str(h, 'hostname'), mac: str(h, 'mac').toLowerCase(), ip: str(h, 'ip') }));
}

function pickNode(nodes: MeshNode[], wanted: string): MeshNode {
  const needle = wanted.trim().toLowerCase();
  const mac = isMac(needle) ? normMac(needle) : null;
  let matches = nodes.filter(n => n.mac === mac || n.ip === needle || n.name.toLowerCase() === needle);
  if (matches.length === 0) matches = nodes.filter(n => n.name.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0] as MeshNode;
  const known = nodes.map(n => `${n.name || n.mac} (${n.ip})`).join(', ') || 'none';
  throw new ValidationError(
    matches.length === 0
      ? `No Mesh node matches "${wanted}". Nodes: ${known}.`
      : `"${wanted}" matches several Mesh nodes: ${known}. Use the MAC.`
  );
}

export function registerMeshTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_mesh_candidates',
    {
      title: 'Find new routers ready to join the Mesh',
      description:
        'Keenetic routers the controller can see that are not part of the Wi-Fi system yet - ' +
        'typically one just taken out of the box (or factory-reset) and plugged into this ' +
        'router or one of its nodes by cable. An empty list means none is visible: check ' +
        'that the new router is powered, cabled to a LAN port, and still in factory state. ' +
        'Adopt one with acquire_mesh_node.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const candidates = candidatesOf(await ctx.client.rci.get('show/mws/candidate'));
      return ok(
        {
          candidates,
          total: candidates.length,
          ...(candidates.length === 0
            ? {
                note:
                  'No router is waiting to be adopted. A new one appears here within a minute ' +
                  'or two of being cabled to the network in factory state.'
              }
            : {})
        },
        ctx.maxResponseBytes
      );
    })
  );

  // What a node holds is read through its own API, so that needs a way to
  // open a second connection. Absent in tests that do not provide one.
  const connect = ctx.connect;
  if (connect) registerNodeCall(server, ctx, connect);

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'acquire_mesh_node',
    {
      title: 'Adopt a new router into the Mesh',
      description:
        'Makes a router from list_mesh_candidates part of this Wi-Fi system: it becomes an ' +
        'extender, takes over the Wi-Fi names, passwords and segments of the controller, and ' +
        'is managed from here afterwards. This is the whole setup for a new node - nothing ' +
        'needs configuring on the new router itself. Its current settings are REPLACED. ' +
        'Adoption takes a few minutes and the node restarts; watch it arrive with ' +
        'get_mesh_nodes. Requires accept_eula=true: adopting accepts the KeeneticOS end-user ' +
        'licence on the new device, which is the user\'s decision to make.',
      inputSchema: {
        candidate: z.string().describe('MAC (or cid) of the candidate, from list_mesh_candidates.'),
        accept_eula: z
          .literal(true)
          .describe('Must be true. Ask the user: it accepts the licence agreement for the new device.'),
        update_firmware: z
          .boolean()
          .optional()
          .describe(
            'true lets the node update its firmware while joining (slower; recommended when ' +
              'versions differ a lot). Defaults to false.'
          )
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    guard(async ({ candidate, update_firmware }): Promise<ToolResult> => {
      const wanted = isMac(candidate) ? normMac(candidate) : cliWord(candidate, 'candidate');

      // Checked against what the controller actually sees, so a mistyped
      // address is caught here rather than reported by the router as a bare
      // "argument parse error".
      const candidates = candidatesOf(await ctx.client.rci.get('show/mws/candidate'));
      const known = candidates.map(c => candidateId(c).toLowerCase());
      if (!known.includes(wanted.toLowerCase()) && !candidates.some(c => str(c, 'cid') === wanted)) {
        return fail(
          new ValidationError(
            candidates.length === 0
              ? 'No router is waiting to be adopted, so there is nothing to acquire. Cable the ' +
                'new router to the network in factory state and call list_mesh_candidates.'
              : `"${candidate}" is not among the candidates: ${known.join(', ')}.`
          )
        );
      }

      const snapshot = await ctx.backup.ensure();
      const line = `mws acquire ${wanted} eula-accept${update_firmware === true ? '' : ' no-update'}`;
      const answer = await runCli(ctx.client.rci, line);

      return ok({
        acquiring: wanted,
        firmwareUpdate: update_firmware === true,
        backup: snapshot.path,
        router: answer,
        note:
          'The controller accepted the request. The node now restarts and joins, which takes ' +
          'a few minutes: call get_mesh_nodes until it is listed as an active extender, then ' +
          'save_config so the controller remembers it after a reboot.'
      });
    })
  );
}

function registerNodeCall(
  server: McpServer,
  ctx: ToolContext,
  connect: (host: string) => KeeneticClient
): void {
  server.registerTool(
    'mesh_node_rci',
    {
      title: 'Call the API of a Mesh node',
      description:
        'Sends a raw RCI request to a Mesh extender itself rather than to the controller, ' +
        'for what only the node knows or holds: its own interfaces and ports, the clients ' +
        'on its radios (show/associations), its log (use rci_call-style paths), its system ' +
        'load. GET reads a path such as "show/system"; POST sends a command object. The ' +
        'node is addressed by name, MAC or IP and must be one the controller lists in ' +
        'get_mesh_nodes. Wi-Fi names, passwords and segments are owned by the controller ' +
        'and pushed to every node - change those on the controller, not here, or the next ' +
        'sync undoes it. Nothing is backed up or saved for you on the node.',
      inputSchema: {
        node: z.string().describe('The extender: its name, MAC or IP from get_mesh_nodes.'),
        method: z.enum(['GET', 'POST']).describe('GET reads, POST executes a command.'),
        path: z.string().optional().describe('Path after /rci/, for GET. Example: show/system'),
        body: z
          .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .optional()
          .describe('Command object for POST, or an array of them.'),
        max_bytes: z
          .number()
          .int()
          .min(200)
          .optional()
          .describe('Lower the response ceiling for this call. It can never raise it.')
      },
      annotations: ctx.readOnly
        ? { readOnlyHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    guard(async ({ node, method, path, body, max_bytes }): Promise<ToolResult> => {
      // The router's credentials are about to be offered to this address, so
      // it has to be one the controller itself vouches for as a Mesh node.
      const target = pickNode(await meshNodes(ctx), node);
      if (!target.ip || target.ip === '0.0.0.0') {
        return fail(new ValidationError(`Mesh node "${target.name || target.mac}" has no IP address right now.`));
      }
      const ceiling = Math.min(ctx.maxResponseBytes, max_bytes ?? ctx.maxResponseBytes);
      const rci = connect(target.ip).rci;

      if (method === 'GET') {
        if (!path) return fail(new ValidationError('GET needs a path, for example "show/system".'));
        return ok({ node: target.name || target.mac, ip: target.ip, result: await rci.get(path) }, ceiling);
      }
      if (body === undefined) {
        return fail(new ValidationError('POST needs a body, for example {"show": {"system": {}}}.'));
      }
      if (ctx.readOnly && !isReadOnlyBody(body)) {
        return fail(
          new ValidationError(
            'This server is running read-only, so only `show` commands may be sent to a node.'
          )
        );
      }
      return ok({ node: target.name || target.mac, ip: target.ip, result: await rci.post(body) }, ceiling);
    })
  );
}
