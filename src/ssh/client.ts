import { Socket } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SshClientOptions {
  host: string;
  port: number;
  user: string;
  /** One of password / privateKey. */
  password?: string;
  privateKey?: Buffer;
  /** Shown in errors instead of the key. */
  keyPath?: string;
  passphrase?: string;
}

/**
 * Turns an ssh2 failure into something a model can act on. The two failures
 * that actually happen on a Keenetic are "nothing listens there" (dropbear not
 * installed or not started, or the wrong port) and "wrong credentials", and the
 * fix for each is different.
 */
export function explainSshError(opts: SshClientOptions, message: string): string {
  const where = `${opts.user}@${opts.host}:${String(opts.port)}`;
  const auth = opts.privateKey ? `key ${opts.keyPath ?? '(inline)'}` : 'password';
  if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|Timed out while waiting for handshake/i.test(message)) {
    return (
      `SSH to ${where} failed: ${message}. Nothing accepted the connection. Entware's dropbear ` +
      'listens on 222 by default; the KeeneticOS SSH server (the router CLI, not a shell) on 22 ' +
      'unless moved. Run ssh_check to see which ports answer, then set KEENETIC_SSH_PORT or ' +
      're-run init. If no port answers, dropbear is not installed or not running (opkg install ' +
      'dropbear, then /opt/etc/init.d/S51dropbear start).'
    );
  }
  if (/authentication methods failed|All configured authentication/i.test(message)) {
    return (
      `SSH to ${where} reached the server but it rejected the ${auth}. Entware's default is ` +
      'root / keenetic until changed. Fix KEENETIC_SSH_USER / KEENETIC_SSH_PASSWORD / ' +
      'KEENETIC_SSH_KEY or re-run init. Note that dropbear locks nothing out, but the ' +
      'KeeneticOS server does after 5 failures.'
    );
  }
  return `SSH to ${where} failed: ${message}. Run ssh_check, or fix the KEENETIC_SSH_* settings.`;
}

export interface PortProbe {
  port: number;
  open: boolean;
  /** The SSH identification line, e.g. "SSH-2.0-dropbear". */
  banner: string | null;
  error?: string;
}

/** Connects, reads the first line, hangs up. No authentication is attempted. */
export function probePort(host: string, port: number, timeoutMs = 3000): Promise<PortProbe> {
  return new Promise(resolve => {
    const socket = new Socket();
    let buffer = '';
    let connected = false;
    let done = false;
    const finish = (result: PortProbe): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({ port, open: connected, banner: buffer.trim() || null, ...(connected ? {} : { error: 'timeout' }) })
    );
    socket.on('connect', () => {
      connected = true;
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      const line = buffer.split(/\r?\n/)[0] ?? '';
      if (buffer.includes('\n') || buffer.length > 200) {
        finish({ port, open: true, banner: line.trim().slice(0, 120) || null });
      }
    });
    socket.on('error', (err: Error & { code?: string }) =>
      finish({ port, open: false, banner: null, error: err.code ?? err.message })
    );
    socket.on('close', () => finish({ port, open: connected, banner: buffer.trim() || null }));
    socket.connect(port, host);
  });
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
export function connectConfig(opts: SshClientOptions): ConnectConfig {
  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.user,
    readyTimeout: 10_000
  };
  if (opts.privateKey) {
    config.privateKey = opts.privateKey;
    if (opts.passphrase) config.passphrase = opts.passphrase;
  } else if (opts.password !== undefined) {
    config.password = opts.password;
    // Some dropbear builds only offer keyboard-interactive for passwords.
    config.tryKeyboard = true;
  }
  return config;
}

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
          .on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
            // Answer every prompt with the password; there is nothing else to give.
            finish(prompts.map(() => opts.password ?? ''));
          })
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
              reject(new Error(explainSshError(opts, err.message)));
            }
          })
          .connect(connectConfig(opts));
      });
    }
  };
}
