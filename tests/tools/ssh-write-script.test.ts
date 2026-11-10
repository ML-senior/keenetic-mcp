import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWriteScript } from '../../src/tools/ssh.js';

/**
 * The script is the part of ssh_write_file that touches a filesystem, and a
 * mocked SSH client proves nothing about it. So it is run here, for real,
 * under the local `sh` - the same POSIX subset BusyBox gives the router.
 */
function hasMd5sum(): boolean {
  try {
    execFileSync('md5sum', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

function run(path: string, content: string, expected = md5(content)) {
  const result = spawnSync(
    'sh',
    ['-c', buildWriteScript(path, `${path}.tmp-x`, `${path}.bak-x`, expected)],
    { input: content, encoding: 'utf8' }
  );
  return { code: result.status, stdout: result.stdout };
}

describe.skipIf(process.platform === 'win32' || !hasMd5sum())('the ssh_write_file script', () => {
  it('creates a new file and prints its checksum last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-'));
    const path = join(dir, 'app.conf');
    const out = run(path, 'hello\n');
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n').pop()).toBe(md5('hello\n'));
    expect(out.stdout).not.toContain('BACKED_UP');
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
    expect(readdirSync(dir)).toEqual(['app.conf']);
  });

  it('keeps the previous version as a backup and preserves the mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-'));
    const path = join(dir, 'S99app');
    writeFileSync(path, 'old\n');
    chmodSync(path, 0o755);

    const out = run(path, 'new\n');
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('BACKED_UP');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(readFileSync(`${path}.bak-x`, 'utf8')).toBe('old\n');
    // An init script that lost its executable bit would silently stop starting.
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).sort()).toEqual(['S99app', 'S99app.bak-x']);
  });

  it('leaves the existing file alone when the content arrives damaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-'));
    const path = join(dir, 'app.conf');
    writeFileSync(path, 'working config\n');

    const out = run(path, 'truncat', md5('truncated in transit\n'));
    expect(out.code).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe('working config\n');
    // No temporary file and no backup left behind either.
    expect(readdirSync(dir)).toEqual(['app.conf']);
  });

  it('writes through a symlink instead of replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-'));
    const target = join(dir, 'real.conf');
    const link = join(dir, 'link.conf');
    writeFileSync(target, 'old\n');
    symlinkSync(target, link);

    expect(run(link, 'new\n').code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(statSync(link).isFile()).toBe(true);
    expect(readdirSync(dir)).toContain('link.conf');
  });

  it('carries content that is not ASCII, and content with shell metacharacters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-'));
    const path = join(dir, 'app.conf');
    const content = "name='\u041f\u044b\u043b\u0435\u0441\u043e\u0441' $(rm -rf /) `id` \\n\n";
    expect(run(path, content).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });
});
