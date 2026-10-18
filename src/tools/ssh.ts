import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { SshClient } from '../ssh/client.js';
import { checkCommand, checkReadablePath, checkWritablePath } from '../ssh/guard.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

async function runChecked(
  ssh: SshClient,
  command: string,
  timeoutMs: number,
  maxResponseBytes: number
): Promise<ToolResult> {
  const blocked = checkCommand(command);
  if (blocked) {
    return fail(new Error(`${blocked.reason} No SSH command was sent.`));
  }
  const result = await ssh.exec(command, timeoutMs);
  return ok(
    {
      command,
      exitCode: result.code,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd()
    },
    maxResponseBytes
  );
}

/**
 * Shell access over SSH: Entware packages, their configs, arbitrary commands.
 *
 * Registered only when the server was started with SSH explicitly enabled
 * (--ssh / KEENETIC_SSH=1) and never in read-only mode: an arbitrary command
 * runner cannot be made read-only by filtering, so in that mode the agent
 * does not get to see these tools at all.
 */
export function registerSshTools(server: McpServer, ctx: ToolContext): void {
  const ssh = ctx.ssh;
  if (!ssh || ctx.readOnly) return;

  server.registerTool(
    'ssh_exec',
    {
      title: 'Run a shell command on the router',
      description:
        'Executes a command over SSH and returns stdout, stderr and the exit code. This is ' +
        'the Entware/Linux shell of the router itself: opkg, the files under /opt, process ' +
        'list, and so on. Destructive system commands (flash writes, rm -rf of system ' +
        'paths, reboot, passwd) are refused; use the dedicated router tools for those.',
      inputSchema: {
        command: z.string().describe('The shell command to run, exactly as typed in a terminal.'),
        timeout_sec: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe('Kill the command after this many seconds. Defaults to 30.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    guard(async ({ command, timeout_sec }) =>
      runChecked(ssh, command, Math.min(timeout_sec ?? 30, 300) * 1000, ctx.maxResponseBytes)
    )
  );

  server.registerTool(
    'ssh_read_file',
    {
      title: 'Read a file on the router',
      description:
        'Reads a file from the router filesystem over SSH (Entware configs live under ' +
        '/opt/etc). Large files are capped; narrow with ssh_exec and sed/grep instead.',
      inputSchema: {
        path: z.string().describe('Absolute path on the router, e.g. /opt/etc/ndm/ndmpg.conf.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ path }) => {
      const blocked = checkReadablePath(path);
      if (blocked) return fail(new Error(blocked.reason));

      const probe = await ssh.exec(`test -f '${path}' && wc -c < '${path}'`, DEFAULT_TIMEOUT_MS);
      if (probe.code !== 0) {
        return fail(new Error(`'${path}' does not exist or is not a regular file on the router.`));
      }
      const bytes = Number.parseInt(probe.stdout.trim(), 10);
      const result = await ssh.exec(`cat '${path}'`, DEFAULT_TIMEOUT_MS);
      if (result.code !== 0) {
        return fail(new Error(`Could not read '${path}': ${result.stderr.trim()}`));
      }
      return ok(
        { path, bytes, content: result.stdout },
        ctx.maxResponseBytes
      );
    })
  );

  server.registerTool(
    'ssh_write_file',
    {
      title: 'Write a file on the router',
      description:
        'Writes a file over SSH, restricted to /opt/ and /tmp/. If the file exists, a ' +
        'timestamped .bak copy is made first, and the write is verified by comparing ' +
        'checksums afterwards - the result includes the backup path and the checksum ' +
        'verdict. Use for Entware service configs; router configuration itself goes ' +
        'through the set_* tools, not files.',
      inputSchema: {
        path: z.string().describe('Absolute path under /opt/ or /tmp/.'),
        content: z.string().describe('The full new content of the file.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ path, content }): Promise<ToolResult> => {
      const blocked = checkWritablePath(path);
      if (blocked) return fail(new Error(blocked.reason));

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${path}.bak-${stamp}`;
      const encoded = Buffer.from(content, 'utf8').toString('base64');
      const expectedMd5 = md5(content);

      const write = await ssh.exec(
        `if [ -f '${path}' ]; then cp -p '${path}' '${backupPath}'; echo BACKED_UP; fi && ` +
          `echo '${encoded}' | base64 -d > '${path}' && md5sum '${path}' | cut -d' ' -f1`,
        DEFAULT_TIMEOUT_MS
      );
      if (write.code !== 0) {
        return fail(
          new Error(`Write to '${path}' failed (exit ${String(write.code)}): ${write.stderr.trim()}`)
        );
      }

      const actualMd5 = write.stdout.trim().split('\n').pop() ?? '';
      if (actualMd5 !== expectedMd5) {
        return fail(
          new Error(
            `Wrote '${path}' but the checksum does not match (expected ${expectedMd5}, got ${actualMd5}). ` +
              `Do not trust the file; the previous version is at ${backupPath} if one existed.`
          )
        );
      }

      return ok({
        path,
        bytes: Buffer.byteLength(content, 'utf8'),
        backup: write.stdout.includes('BACKED_UP') ? backupPath : null,
        md5Verified: true,
        note: 'File written and checksum-verified. Restart the affected service to apply it.'
      });
    })
  );

  server.registerTool(
    'opkg_manage',
    {
      title: 'Manage Entware packages',
      description:
        'Wraps opkg, the Entware package manager: update the package lists, install or ' +
        'remove a package, list available or installed packages, show package info. ' +
        'Returns the full opkg output. Requires the Entware USB setup to be healthy - ' +
        'check get_media and get_opkg_status first if anything looks wrong.',
      inputSchema: {
        action: z
          .enum(['update', 'install', 'remove', 'list', 'list-installed', 'info'])
          .describe('What to do.'),
        package: z
          .string()
          .optional()
          .describe('Package name. Required for install, remove and info.'),
        timeout_sec: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe('update and install can be slow. Defaults to 120.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    guard(async ({ action, package: pkg, timeout_sec }): Promise<ToolResult> => {
      const needsPackage = action === 'install' || action === 'remove' || action === 'info';
      if (needsPackage && !pkg) {
        return fail(new Error(`'${action}' needs a package name.`));
      }
      if (pkg && !/^[a-z0-9][a-z0-9+._-]*$/i.test(pkg)) {
        return fail(new Error(`'${pkg}' is not a plausible package name.`));
      }

      const command = pkg ? `opkg ${action} ${pkg}` : `opkg ${action}`;
      const timeoutMs = Math.min(timeout_sec ?? 120, 300) * 1000;
      return runChecked(ssh, command, timeoutMs, ctx.maxResponseBytes);
    })
  );
}
