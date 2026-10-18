import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

const STORED = { host: '192.0.2.1', login: 'admin', password: 'router-pass' };
const env = (e: Record<string, string> = {}): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

describe('loadConfig SSH', () => {
  it('stays off unless asked for', async () => {
    const cfg = await loadConfig([], env(), STORED);
    expect(cfg.ssh).toBeNull();
  });

  // Entware dropbear: 222 and root. 22 is the KeeneticOS CLI, which is not a shell.
  it('defaults to Entware dropbear, 222 and root', async () => {
    const cfg = await loadConfig(['--ssh'], env({ KEENETIC_SSH_PASSWORD: 'keenetic' }), STORED);
    expect(cfg.ssh).toMatchObject({ port: 222, user: 'root', password: 'keenetic' });
  });

  it('does not hand the router password to root', async () => {
    await expect(loadConfig(['--ssh'], env(), STORED)).rejects.toThrow(/no password or key/);
  });

  it('reuses the router password only for the router account itself', async () => {
    const cfg = await loadConfig(
      ['--ssh'],
      env({ KEENETIC_SSH_USER: 'admin', KEENETIC_SSH_PORT: '22' }),
      STORED
    );
    expect(cfg.ssh).toMatchObject({ port: 22, user: 'admin', password: 'router-pass' });
  });

  it('reads a key file instead of a password', async () => {
    const cfg = await loadConfig(
      ['--ssh'],
      env({ KEENETIC_SSH_KEY: '/keys/id', KEENETIC_SSH_KEY_PASSPHRASE: 'pp' }),
      STORED,
      async path => Buffer.from(`key at ${path}`)
    );
    expect(cfg.ssh?.privateKey?.toString()).toBe('key at /keys/id');
    expect(cfg.ssh?.passphrase).toBe('pp');
    expect(cfg.ssh?.password).toBeUndefined();
  });

  it('explains an unreadable key', async () => {
    await expect(
      loadConfig(['--ssh'], env({ KEENETIC_SSH_KEY: '/nope' }), STORED, async () => {
        throw new Error('ENOENT');
      })
    ).rejects.toThrow(/Cannot read the SSH key \/nope/);
  });

  it('turns on from a stored setup, with its port, user and secret', async () => {
    const cfg = await loadConfig([], env(), {
      ...STORED,
      ssh: { port: 2222, user: 'root', password: 's3cret' }
    });
    expect(cfg.ssh).toMatchObject({ port: 2222, user: 'root', password: 's3cret' });
  });

  it('lets KEENETIC_SSH=0 switch a stored setup off', async () => {
    const cfg = await loadConfig([], env({ KEENETIC_SSH: '0' }), {
      ...STORED,
      ssh: { port: 222, user: 'root', password: 's' }
    });
    expect(cfg.ssh).toBeNull();
  });

  it('lets the environment beat the stored port', async () => {
    const cfg = await loadConfig([], env({ KEENETIC_SSH_PORT: '2200' }), {
      ...STORED,
      ssh: { port: 222, user: 'root', password: 's' }
    });
    expect(cfg.ssh?.port).toBe(2200);
  });

  it('rejects a nonsense port', async () => {
    await expect(
      loadConfig(['--ssh', '--ssh-port', '22x'], env({ KEENETIC_SSH_PASSWORD: 'p' }), STORED)
    ).rejects.toThrow(/1-65535/);
  });
});
