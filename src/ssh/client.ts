import { Client } from 'ssh2';

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SshClientOptions {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** The seam the tool layer depends on. Tests substitute a plain object. */
export interface SshClient {
  exec(command: string, timeoutMs: number): Promise<SshExecResult>;
}

/**
 * One connection per command. Shell access here is a handful of commands a
 * minute, not a stream, and a stateless connect sidesteps every flavour of
 * stale-connection bug a long-lived session to a dropbear server collects.
 */
export function createSshClient(opts: SshClientOptions): SshClient {
  return {
    exec(command: string, timeoutMs: number): Promise<SshExecResult> {
      return new Promise((resolve, reject) => {
        const conn = new Client();
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          conn.end();
          reject(
            new Error(
              `SSH command timed out after ${String(timeoutMs)} ms. The router may still be ` +
                'running it - check before retrying (e.g. ssh_exec "ps | grep opkg").'
            )
          );
        }, timeoutMs);

        let stdout = '';
        let stderr = '';

        conn
          .on('ready', () => {
            conn.exec(command, (err, stream) => {
              if (err) {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  conn.end();
                  reject(err);
                }
                return;
              }
              let code: number | null = null;
              stream.on('data', (d: Buffer) => {
                stdout += d.toString('utf8');
              });
              stream.stderr.on('data', (d: Buffer) => {
                stderr += d.toString('utf8');
              });
              stream.on('close', (exitCode: number | null) => {
                code = exitCode;
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  conn.end();
                  resolve({ stdout, stderr, code });
                }
              });
            });
          })
          .on('error', (err: Error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(
                new Error(
                  `SSH to ${opts.host}:${String(opts.port)} failed: ${err.message}. ` +
                    'Check that the SSH server component is enabled on the router and the ' +
                    'KEENETIC_SSH_* settings match it.'
                )
              );
            }
          })
          .connect({
            host: opts.host,
            port: opts.port,
            username: opts.user,
            password: opts.password,
            readyTimeout: 10_000
          });
      });
    }
  };
}
