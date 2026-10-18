import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectConfig, explainSshError, probePort } from '../../src/ssh/client.js';

const BASE = { host: '192.0.2.1', port: 222, user: 'root' };

describe('explainSshError', () => {
  it('points a refused connection at dropbear and ssh_check', () => {
    const text = explainSshError({ ...BASE, password: 'x' }, 'connect ECONNREFUSED 192.0.2.1:222');
    expect(text).toMatch(/222/);
    expect(text).toMatch(/ssh_check/);
    expect(text).toMatch(/dropbear/);
  });

  it('tells a rejected password apart from a closed port', () => {
    const text = explainSshError({ ...BASE, password: 'x' }, 'All configured authentication methods failed');
    expect(text).toMatch(/rejected the password/);
  });

  it('names the key file, never the key', () => {
    const text = explainSshError(
      { ...BASE, privateKey: Buffer.from('SECRET'), keyPath: '/k/id' },
      'All configured authentication methods failed'
    );
    expect(text).toContain('/k/id');
    expect(text).not.toContain('SECRET');
  });
});

describe('connectConfig', () => {
  it('uses the key and not a password when both could apply', () => {
    const cfg = connectConfig({ ...BASE, privateKey: Buffer.from('k'), passphrase: 'pp' });
    expect(cfg.privateKey).toBeDefined();
    expect(cfg.passphrase).toBe('pp');
    expect(cfg.password).toBeUndefined();
  });

  it('allows keyboard-interactive for password logins', () => {
    expect(connectConfig({ ...BASE, password: 'p' })).toMatchObject({ password: 'p', tryKeyboard: true });
  });
});

describe('probePort', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  it('reads the SSH banner of an open port', async () => {
    server = createServer(socket => socket.write('SSH-2.0-dropbear\r\n'));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await expect(probePort('127.0.0.1', port)).resolves.toMatchObject({
      open: true,
      banner: 'SSH-2.0-dropbear'
    });
  });

  it('reports a closed port as closed', async () => {
    server = createServer();
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    server.close();
    server = null;
    await expect(probePort('127.0.0.1', port)).resolves.toMatchObject({ open: false });
  });
});
