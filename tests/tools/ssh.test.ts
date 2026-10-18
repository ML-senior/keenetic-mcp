import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { registerSshTools } from '../../src/tools/ssh.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import type { SshClient, SshExecResult } from '../../src/ssh/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface FakeSsh {
  client: SshClient;
  commands: string[];
  respond: (command: string) => SshExecResult;
}

function fakeSsh(respond?: (command: string) => SshExecResult): FakeSsh {
  const commands: string[] = [];
  const defaultRespond = (command: string): SshExecResult => {
    if (command.startsWith('test -f ')) return { stdout: '42\n', stderr: '', code: 0 };
    if (command.startsWith('cat ')) return { stdout: 'file-content\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const fn = respond ?? defaultRespond;
  return {
    commands,
    respond: fn,
    client: {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        return fn(command);
      })
    }
  };
}

function harness(opts: { ssh?: SshClient; readOnly?: boolean } = {}): Record<string, Handler> {
  const client = {
    rci: { get: vi.fn(), post: vi.fn(), getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _config: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  const ctx: ToolContext = {
    client,
    maxResponseBytes: 25_000,
    readOnly: opts.readOnly ?? false,
    backup: stubBackup()
  };
  if (opts.ssh) ctx.ssh = opts.ssh;

  registerSshTools(server, ctx);
  return handlers;
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('registration gating', () => {
  it('registers nothing without an ssh client', () => {
    expect(Object.keys(harness())).toHaveLength(0);
  });

  it('registers nothing in read-only mode even with ssh configured', () => {
    expect(Object.keys(harness({ ssh: fakeSsh().client, readOnly: true }))).toHaveLength(0);
  });

  it('registers all four tools with ssh enabled', () => {
    const h = harness({ ssh: fakeSsh().client });
    expect(Object.keys(h).sort()).toEqual([
      'opkg_manage',
      'ssh_exec',
      'ssh_read_file',
      'ssh_write_file'
    ]);
  });
});

describe('ssh_exec', () => {
  it('runs the command and returns stdout, stderr and exit code', async () => {
    const ssh = fakeSsh(() => ({ stdout: 'total 4\n', stderr: '', code: 0 }));
    const out = payload(await harness({ ssh: ssh.client })['ssh_exec']!({ command: 'ls -la /opt' }));
    expect(ssh.commands).toEqual(['ls -la /opt']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('total 4');
  });

  it('reports a non-zero exit code as a result, not a crash', async () => {
    const ssh = fakeSsh(() => ({ stdout: '', stderr: 'opkg: not found\n', code: 127 }));
    const out = payload(await harness({ ssh: ssh.client })['ssh_exec']!({ command: 'opkg' }));
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toContain('not found');
  });

  it.each([
    ['rm -rf /', 'filesystem root'],
    ['rm -rf /opt', 'Entware'],
    ['dd if=/dev/zero of=/dev/mtd0', 'block device'],
    ['sysupgrade firmware.bin', 'firmware'],
    ['reboot', 'reboot_router'],
    ['passwd', 'lock']
  ])('refuses %s without sending anything', async (command, why) => {
    const ssh = fakeSsh();
    const result = await harness({ ssh: ssh.client })['ssh_exec']!({ command });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(why);
    expect(ssh.commands).toHaveLength(0);
  });

  it('allows a command merely mentioning blocked words in an argument', async () => {
    const ssh = fakeSsh();
    const out = payload(
      await harness({ ssh: ssh.client })['ssh_exec']!({ command: 'grep reboot /opt/etc/log.conf' })
    );
    expect(out.exitCode).toBe(0);
    expect(ssh.commands).toHaveLength(1);
  });
});

describe('ssh_read_file', () => {
  it('returns file content with its size', async () => {
    const out = payload(
      await harness({ ssh: fakeSsh().client })['ssh_read_file']!({ path: '/opt/etc/app.conf' })
    );
    expect(out.content).toBe('file-content\n');
    expect(out.bytes).toBe(42);
  });

  it('reports a missing file', async () => {
    const ssh = fakeSsh(cmd =>
      cmd.startsWith('test -f ') ? { stdout: '', stderr: '', code: 1 } : { stdout: '', stderr: '', code: 0 }
    );
    const result = await harness({ ssh: ssh.client })['ssh_read_file']!({ path: '/opt/etc/none.conf' });
    expect(result.isError).toBe(true);
  });

  it.each([['/etc/../etc/passwd'], ["'quoted'"], ['relative/path']])(
    'refuses the path %s',
    async path => {
      const result = await harness({ ssh: fakeSsh().client })['ssh_read_file']!({ path });
      expect(result.isError).toBe(true);
    }
  );
});

describe('ssh_write_file', () => {
  function writeHarness(content: string) {
    const expected = createHash('md5').update(content, 'utf8').digest('hex');
    const ssh = fakeSsh(cmd => {
      if (cmd.startsWith('if [ -f ')) return { stdout: `BACKED_UP\n${expected}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    return { ssh, expected };
  }

  it('backs up, writes via base64 and verifies the md5', async () => {
    const { ssh } = writeHarness('new-config\n');
    const out = payload(
      await harness({ ssh: ssh.client })['ssh_write_file']!({
        path: '/opt/etc/app.conf',
        content: 'new-config\n'
      })
    );
    expect(out.md5Verified).toBe(true);
    expect(out.backup).toMatch(/^\/opt\/etc\/app\.conf\.bak-/);
    expect(ssh.commands[0]).toContain('base64 -d');
    expect(ssh.commands[0]).toContain("cp -p '/opt/etc/app.conf'");
  });

  it('fails loudly when the checksum does not match', async () => {
    const ssh = fakeSsh(() => ({ stdout: 'deadbeef\n', stderr: '', code: 0 }));
    const result = await harness({ ssh: ssh.client })['ssh_write_file']!({
      path: '/opt/etc/app.conf',
      content: 'x'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('checksum does not match');
  });

  it.each([['/etc/passwd'], ['/opt/../etc/x'], ['/home/user/x']])(
    'refuses to write %s',
    async path => {
      const ssh = fakeSsh();
      const result = await harness({ ssh: ssh.client })['ssh_write_file']!({ path, content: 'x' });
      expect(result.isError).toBe(true);
      expect(ssh.commands).toHaveLength(0);
    }
  );
});

describe('opkg_manage', () => {
  it('builds the opkg command', async () => {
    const ssh = fakeSsh(() => ({ stdout: 'installed ok\n', stderr: '', code: 0 }));
    const out = payload(
      await harness({ ssh: ssh.client })['opkg_manage']!({ action: 'install', package: 'nano' })
    );
    expect(ssh.commands).toEqual(['opkg install nano']);
    expect(out.exitCode).toBe(0);
  });

  it('requires a package for install/remove/info', async () => {
    const result = await harness({ ssh: fakeSsh().client })['opkg_manage']!({ action: 'install' });
    expect(result.isError).toBe(true);
  });

  it('rejects a package name with shell metacharacters', async () => {
    const ssh = fakeSsh();
    const result = await harness({ ssh: ssh.client })['opkg_manage']!({
      action: 'install',
      package: 'nano; rm -rf /opt'
    });
    expect(result.isError).toBe(true);
    expect(ssh.commands).toHaveLength(0);
  });
});
