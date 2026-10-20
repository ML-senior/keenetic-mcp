import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit, type InitDeps } from '../../src/cli/init.js';
import { readStoredConfig } from '../../src/config/discover.js';

async function makeDeps(
  over: Partial<InitDeps> = {}
): Promise<{ deps: InitDeps; out: string[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kn-init-'));
  const out: string[] = [];
  const deps: InitDeps = {
    configDir: dir,
    prompt: vi.fn(async () => ''),
    hidden: vi.fn(async () => 'hunter2'),
    out: line => out.push(line),
    store: {
      save: vi.fn(async () => 'the system keychain'),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => undefined)
    },
    discoverGateway: vi.fn(async () => '192.0.2.1'),
    identify: vi.fn(async () => ({ realm: 'Keenetic Ultra' })),
    verify: vi.fn(async () => ({
      ok: true as const,
      model: 'Keenetic Ultra (KN-1811)',
      firmware: '5.1.3',
      components: 43
    })),
    ...over
  };
  return { deps, out, dir };
}

describe('runInit', () => {
  it('discovers, verifies and stores', async () => {
    const { deps, out, dir } = await makeDeps();
    await expect(runInit(deps)).resolves.toBe(0);

    await expect(readStoredConfig(dir)).resolves.toEqual({ host: '192.0.2.1', login: 'admin' });
    expect(deps.store.save).toHaveBeenCalledWith('admin@192.0.2.1', 'hunter2');
    expect(out.join('\n')).toMatch(/Keenetic Ultra \(KN-1811\)/);
    expect(out.join('\n')).toMatch(/5\.1\.3/);
  });

  it('never prints the password', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    expect(out.join('\n')).not.toContain('hunter2');
  });

  it('names both agents, not just one, plus the generic config', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    const text = out.join('\n');
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/Codex/);
    expect(text).toMatch(/plugin marketplace add ML-senior\/keenetic-mcp/);
    expect(text).toMatch(/"command": "node"/);
    // In the built package this is dist/index.js; under vitest it is src/index.ts.
    expect(text).toMatch(/index\.(js|ts)/);
  });

  it('fails with a usable message when nothing answers at the gateway', async () => {
    const { deps, out } = await makeDeps({ identify: vi.fn(async () => null) });
    await expect(runInit(deps)).resolves.toBe(1);
    expect(out.join('\n')).toMatch(/Keenetic/i);
  });

  it('stores nothing when the credentials are rejected', async () => {
    const { deps, out, dir } = await makeDeps({
      verify: vi.fn(async () => ({ ok: false as const, reason: 'HTTP 401' }))
    });
    await expect(runInit(deps)).resolves.toBe(1);
    expect(deps.store.save).not.toHaveBeenCalled();
    await expect(readStoredConfig(dir)).resolves.toBeNull();
    expect(out.join('\n')).toMatch(/rejected|401/i);
  });

  it('takes the host the user types over the discovered one', async () => {
    const { deps } = await makeDeps({ prompt: vi.fn(async () => '198.51.100.7') });
    await runInit(deps);
    expect(deps.identify).toHaveBeenCalledWith('198.51.100.7');
  });

  it('falls back to a sensible default when no gateway is found', async () => {
    const { deps } = await makeDeps({ discoverGateway: vi.fn(async () => null) });
    await runInit(deps);
    expect(deps.identify).toHaveBeenCalledWith('192.168.1.1');
  });

  it('reports where the secret went', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    expect(out.join('\n')).toMatch(/system keychain/);
  });

  it('verifies before it writes anything', async () => {
    const order: string[] = [];
    const { deps } = await makeDeps({
      verify: vi.fn(async () => {
        order.push('verify');
        return { ok: true as const, model: 'M', firmware: '5.1.3', components: 1 };
      }),
      store: {
        save: vi.fn(async () => {
          order.push('save');
          return 'the system keychain';
        }),
        read: vi.fn(async () => null),
        remove: vi.fn(async () => undefined)
      }
    });
    await runInit(deps);
    expect(order).toEqual(['verify', 'save']);
  });
});

describe('runInit SSH', () => {
  /** Answers prompts by matching their text; anything unmatched takes the default. */
  function answering(map: Record<string, string>): InitDeps['prompt'] {
    return vi.fn(async (question: string) => {
      for (const [needle, answer] of Object.entries(map)) {
        if (question.includes(needle)) return answer;
      }
      return '';
    });
  }

  it('skips SSH by default and writes no ssh block', async () => {
    const verifySsh = vi.fn();
    const { deps, dir } = await makeDeps({ verifySsh });
    await expect(runInit(deps)).resolves.toBe(0);
    expect(verifySsh).not.toHaveBeenCalled();
    await expect(readStoredConfig(dir)).resolves.toEqual({ host: '192.0.2.1', login: 'admin' });
  });

  it('asks port, user and password, verifies, and stores the password in the keychain', async () => {
    const hidden = vi
      .fn()
      .mockResolvedValueOnce('router-pass')
      .mockResolvedValueOnce('dropbear-pass-1');
    const verifySsh = vi.fn(async () => ({ ok: true as const, detail: 'Linux aarch64, Entware found' }));
    const { deps, out, dir } = await makeDeps({
      prompt: answering({ 'Enable SSH': 'y' }),
      hidden,
      verifySsh
    });

    await expect(runInit(deps)).resolves.toBe(0);
    expect(verifySsh).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.0.2.1', port: 222, user: 'root', password: 'dropbear-pass-1' })
    );
    expect(deps.store.save).toHaveBeenCalledWith('ssh:root@192.0.2.1', 'dropbear-pass-1');
    await expect(readStoredConfig(dir)).resolves.toEqual({
      host: '192.0.2.1',
      login: 'admin',
      ssh: { port: 222, user: 'root', auth: 'password' }
    });
    expect(out.join('\n')).not.toContain('dropbear-pass-1');
    expect(out.join('\n')).toMatch(/root@192\.0\.2\.1:222/);
  });

  it('takes a key file and keeps only its path on disk', async () => {
    const hidden = vi.fn().mockResolvedValueOnce('router-pass').mockResolvedValueOnce('');
    const verifySsh = vi.fn(async () => ({ ok: true as const, detail: 'ok' }));
    const { deps, dir } = await makeDeps({
      prompt: answering({
        'Enable SSH': 'yes',
        'SSH port': '2222',
        'password or key': 'key',
        'key path': '/keys/router'
      }),
      hidden,
      verifySsh,
      readKey: vi.fn(async () => Buffer.from('PRIVATE'))
    });

    await expect(runInit(deps)).resolves.toBe(0);
    expect(verifySsh).toHaveBeenCalledWith(
      expect.objectContaining({ port: 2222, privateKey: Buffer.from('PRIVATE'), keyPath: '/keys/router' })
    );
    await expect(readStoredConfig(dir)).resolves.toEqual({
      host: '192.0.2.1',
      login: 'admin',
      ssh: { port: 2222, user: 'root', auth: 'key', keyPath: '/keys/router' }
    });
    // No passphrase, nothing to put in the keychain beyond the router password.
    expect(deps.store.save).toHaveBeenCalledTimes(1);
  });

  it('drops SSH when the login fails and the user does not insist', async () => {
    const verifySsh = vi.fn(async () => ({ ok: false as const, reason: 'ECONNREFUSED' }));
    const { deps, out, dir } = await makeDeps({
      prompt: answering({ 'Enable SSH': 'y' }),
      verifySsh
    });
    await expect(runInit(deps)).resolves.toBe(0);
    expect(out.join('\n')).toMatch(/ECONNREFUSED/);
    await expect(readStoredConfig(dir)).resolves.toEqual({ host: '192.0.2.1', login: 'admin' });
  });

  it('re-asks a bad port instead of failing', async () => {
    const prompt = vi.fn(async (q: string) => {
      if (q.includes('Enable SSH')) return 'y';
      if (q.includes('SSH port')) return prompt.mock.calls.filter(c => String(c[0]).includes('SSH port')).length === 1 ? 'abc' : '222';
      return '';
    });
    const { deps, out } = await makeDeps({
      prompt,
      verifySsh: vi.fn(async () => ({ ok: true as const, detail: 'ok' }))
    });
    await expect(runInit(deps)).resolves.toBe(0);
    expect(out.join('\n')).toMatch(/1-65535/);
  });
});

describe('runInit with the web UI on another port', () => {
  it('hands SSH the bare host, not host:http-port', async () => {
    const verifySsh = vi.fn(async () => ({ ok: true as const, detail: 'ok' }));
    const { deps, out } = await makeDeps({
      prompt: vi.fn(async (q: string) => (q.includes('Router address') ? '192.0.2.1:8080' : q.includes('Enable SSH') ? 'y' : '')),
      hidden: vi.fn().mockResolvedValueOnce('router-pass').mockResolvedValueOnce('pw'),
      verifySsh
    });
    await expect(runInit(deps)).resolves.toBe(0);
    expect(deps.identify).toHaveBeenCalledWith('192.0.2.1:8080');
    expect(verifySsh).toHaveBeenCalledWith(expect.objectContaining({ host: '192.0.2.1', port: 222 }));
    expect(out.join('\n')).toMatch(/root@192\.0\.2\.1:222/);
  });
});
