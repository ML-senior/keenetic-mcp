import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

const STORED = { host: '198.51.100.1', login: 'stored-user', password: 'stored-pass' };

describe('loadConfig precedence', () => {
  it('uses stored values when the environment is empty', async () => {
    const cfg = await loadConfig([], {} as NodeJS.ProcessEnv, STORED);
    expect(cfg).toMatchObject({
      host: '198.51.100.1',
      login: 'stored-user',
      password: 'stored-pass'
    });
  });

  // Containers and CI have no keychain, so the environment has to win over
  // whatever happens to be configured on a developer machine.
  it('lets the environment override every stored value', async () => {
    const cfg = await loadConfig(
      [],
      {
        KEENETIC_HOST: '192.0.2.9',
        KEENETIC_USER: 'env-user',
        KEENETIC_PASSWORD: 'env-pass'
      } as NodeJS.ProcessEnv,
      STORED
    );
    expect(cfg).toMatchObject({ host: '192.0.2.9', login: 'env-user', password: 'env-pass' });
  });

  it('lets --host override a stored host', async () => {
    const cfg = await loadConfig(['--host', '192.0.2.5'], {} as NodeJS.ProcessEnv, STORED);
    expect(cfg.host).toBe('192.0.2.5');
  });

  it('lets the environment beat the flag', async () => {
    const cfg = await loadConfig(
      ['--host', '192.0.2.5'],
      { KEENETIC_HOST: '192.0.2.9' } as NodeJS.ProcessEnv,
      STORED
    );
    expect(cfg.host).toBe('192.0.2.9');
  });

  it('points at the wizard when nothing is configured', async () => {
    await expect(loadConfig([], {} as NodeJS.ProcessEnv, undefined)).rejects.toThrow(
      /dist\/index\.js init/
    );
  });

  it('points at the wizard when the host is known but the password is not', async () => {
    await expect(
      loadConfig([], {} as NodeJS.ProcessEnv, { host: '192.0.2.1', login: 'admin' })
    ).rejects.toThrow(/dist\/index\.js init/);
  });

  it('defaults the login to admin', async () => {
    const cfg = await loadConfig([], {} as NodeJS.ProcessEnv, {
      host: '192.0.2.1',
      password: 'p'
    });
    expect(cfg.login).toBe('admin');
  });

  it('still honours --read-only and --max-response-bytes', async () => {
    const cfg = await loadConfig(
      ['--read-only', '--max-response-bytes', '8000'],
      {} as NodeJS.ProcessEnv,
      STORED
    );
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxResponseBytes).toBe(8000);
  });

  it('rejects a nonsense --max-response-bytes', async () => {
    await expect(
      loadConfig(['--max-response-bytes', 'lots'], {} as NodeJS.ProcessEnv, STORED)
    ).rejects.toThrow(/positive integer/);
  });
});
