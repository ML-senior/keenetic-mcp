import { describe, expect, it, vi } from 'vitest';
import type { KeeneticClient } from '../../src/router/client.js';
import { registerMeshTools } from '../../src/tools/mesh.js';
import { payload, rig, text } from '../helpers/harness.js';

const HOTSPOT = {
  host: [
    { mac: '02:00:00:00:00:01', ip: '192.0.2.5', name: 'laptop', active: true },
    { mac: '02:00:00:00:00:E1', ip: '192.0.2.41', name: 'hall', 'system-mode': 'extender', active: true },
    { mac: '02:00:00:00:00:e2', ip: '192.0.2.42', name: 'hallway', 'system-mode': 'extender', active: true }
  ]
};
const CANDIDATE = { mac: '02:00:00:00:00:c1', cid: 'cid-new', model: 'KN-0000' };

function nodeClient() {
  const get = vi.fn(async () => ({ hostname: 'node' }));
  const post = vi.fn(async () => ({ show: {} }));
  return { client: { rci: { get, post, getText: vi.fn() }, capabilities: vi.fn() } as unknown as KeeneticClient, get, post };
}

describe('list_mesh_candidates', () => {
  it('explains an empty list instead of just returning one', async () => {
    const out = payload(await rig(registerMeshTools, { get: { 'show/mws/candidate': {} } }).handlers['list_mesh_candidates']!({}));
    expect(out).toMatchObject({ candidates: [], total: 0 });
    expect(out.note).toMatch(/factory state/);
  });

  it.each([
    ['a wrapped list', { candidate: [CANDIDATE] }],
    ['a single unwrapped record', { candidate: CANDIDATE }],
    ['a map keyed by id', { 'cid-new': CANDIDATE }]
  ])('reads %s', async (_label, raw) => {
    const out = payload(await rig(registerMeshTools, { get: { 'show/mws/candidate': raw } }).handlers['list_mesh_candidates']!({}));
    expect(out.total).toBe(1);
    expect(out.candidates[0].mac).toBe('02:00:00:00:00:c1');
  });
});

describe('acquire_mesh_node', () => {
  const setup = (raw: unknown = { candidate: [CANDIDATE] }) => {
    const lines: string[] = [];
    const r = rig(registerMeshTools, {
      get: { 'show/mws/candidate': raw },
      post: (body: any) => {
        lines.push(body.parse);
        return { parse: { prompt: '(config)' } };
      }
    });
    return { call: r.handlers['acquire_mesh_node']!, lines, ctx: r.ctx };
  };

  it('adopts a candidate without a firmware update by default', async () => {
    const { call, lines, ctx } = setup();
    const out = payload(await call({ candidate: '02-00-00-00-00-C1', accept_eula: true }));
    expect(lines).toEqual(['mws acquire 02:00:00:00:00:c1 eula-accept no-update']);
    expect(out).toMatchObject({ acquiring: '02:00:00:00:00:c1', firmwareUpdate: false });
    expect(out.note).toMatch(/get_mesh_nodes/);
    expect(ctx.backup.ensure).toHaveBeenCalledTimes(1);
  });

  it('lets the node update when asked, and accepts a cid', async () => {
    const { call, lines } = setup();
    await call({ candidate: 'cid-new', accept_eula: true, update_firmware: true });
    expect(lines).toEqual(['mws acquire cid-new eula-accept']);
  });

  it('refuses an address that is not a candidate, before sending anything', async () => {
    const { call, lines } = setup();
    const result = await call({ candidate: '02:00:00:00:00:99', accept_eula: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('02:00:00:00:00:c1');
    expect(lines).toEqual([]);
  });

  it('says there is nothing to adopt when no router is waiting', async () => {
    const { call, lines } = setup({});
    const result = await call({ candidate: '02:00:00:00:00:c1', accept_eula: true });
    expect(text(result)).toMatch(/nothing to acquire/);
    expect(lines).toEqual([]);
  });

  it('cannot be steered into a second command', async () => {
    const { call, lines } = setup();
    const result = await call({ candidate: 'cid-new no-update system reboot', accept_eula: true });
    expect(result.isError).toBe(true);
    expect(lines).toEqual([]);
  });

  it('is not offered on a read-only server', () => {
    const names = Object.keys(rig(registerMeshTools, { readOnly: true }).handlers);
    expect(names).toEqual(['list_mesh_candidates']);
  });
});

describe('mesh_node_rci', () => {
  const setup = (readOnly = false) => {
    const node = nodeClient();
    const connect = vi.fn((_host: string) => node.client);
    const r = rig(registerMeshTools, { get: { 'show/ip/hotspot': HOTSPOT, 'show/mws/candidate': {} }, connect, readOnly });
    return { call: r.handlers['mesh_node_rci']!, connect, node, controller: r };
  };

  it('reads from the node itself, found by name', async () => {
    const { call, connect, node, controller } = setup();
    const out = payload(await call({ node: 'hall', method: 'GET', path: 'show/system' }));
    expect(connect).toHaveBeenCalledWith('192.0.2.41');
    expect(node.get).toHaveBeenCalledWith('show/system');
    expect(out).toMatchObject({ node: 'hall', ip: '192.0.2.41', result: { hostname: 'node' } });
    // The controller was asked only who its nodes are.
    expect(controller.get).toHaveBeenCalledTimes(1);
  });

  it('finds a node by MAC in any notation, and by IP', async () => {
    const { call, connect } = setup();
    await call({ node: '02-00-00-00-00-E2', method: 'GET', path: 'show/version' });
    await call({ node: '192.0.2.41', method: 'GET', path: 'show/version' });
    expect(connect.mock.calls.map(c => c[0])).toEqual(['192.0.2.42', '192.0.2.41']);
  });

  it('never offers the credentials to a host that is not a Mesh node', async () => {
    const { call, connect } = setup();
    for (const node of ['laptop', '192.0.2.5', '203.0.113.9', 'evil.example.net']) {
      const result = await call({ node, method: 'GET', path: 'show/version' });
      expect(result.isError).toBe(true);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('asks which node when a partial name fits two', async () => {
    const { call, connect } = setup();
    const result = await call({ node: 'hal', method: 'GET', path: 'show/version' });
    expect(text(result)).toMatch(/several Mesh nodes/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('sends a command to the node', async () => {
    const { call, node } = setup();
    await call({ node: 'hall', method: 'POST', body: { interface: { 'WifiMaster0/AccessPoint1': { up: true } } } });
    expect(node.post).toHaveBeenCalledWith({ interface: { 'WifiMaster0/AccessPoint1': { up: true } } });
  });

  it('on a read-only server lets a show through and nothing else', async () => {
    const { call, node } = setup(true);
    expect((await call({ node: 'hall', method: 'POST', body: { show: { system: {} } } })).isError).toBeUndefined();
    const result = await call({ node: 'hall', method: 'POST', body: { system: { reboot: {} } } });
    expect(result.isError).toBe(true);
    expect(node.post).toHaveBeenCalledTimes(1);
  });

  it('is absent when the server cannot open a second connection', () => {
    const names = Object.keys(rig(registerMeshTools, {}).handlers);
    expect(names).not.toContain('mesh_node_rci');
  });
});
