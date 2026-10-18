import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

/**
 * How the SSH tools reach the router's shell.
 *
 * KeeneticOS itself ships an SSH server, but it lands in the router's own CLI
 * (`show version`, `interface ...`), not in a POSIX shell: `uname`, `opkg` or
 * `cat /opt/etc/...` do not exist there. The shell the SSH tools are written
 * for is Entware's dropbear, which the Keenetic Entware installer puts on port
 * 222 with the user `root` - 22 is left to the KeeneticOS server. Those are
 * the defaults, and the router login is deliberately not reused for them.
 */
export interface SshConfig {
  port: number;
  user: string;
  /** Exactly one of password / privateKey is set. */
  password?: string;
  privateKey?: Buffer;
  /** Where the key came from, for error messages. Never the key itself. */
  keyPath?: string;
  passphrase?: string;
}

export interface AppConfig {
  host: string;
  login: string;
  password: string;
  readOnly: boolean;
  maxResponseBytes: number;
  /** Present only when shell access was explicitly enabled. */
  ssh: SshConfig | null;
}

export interface StoredSsh {
  port?: number;
  user?: string;
  keyPath?: string;
  /** Read from the keychain, never from config.json. */
  password?: string;
  passphrase?: string;
}

export interface StoredCredentials {
  host?: string;
  login?: string;
  password?: string;
  /** Present when `init` set shell access up; that is the opt-in. */
  ssh?: StoredSsh;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 25_000;
/** Entware dropbear on Keenetic. KeeneticOS's own SSH (the CLI) defaults to 22. */
export const DEFAULT_SSH_PORT = 222;
export const DEFAULT_SSH_USER = 'root';

const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return `${homedir()}${path.slice(1)}`;
  return path;
}

export function parsePort(raw: string | number, what = 'SSH port'): number {
  const port = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== String(raw).trim()) {
    throw new Error(`${what} must be 1-65535, got "${String(raw)}"`);
  }
  return port;
}

/**
 * Merges the three sources of configuration.
 *
 * The environment wins over both the flag and the stored value: a container or
 * a CI run has no keychain to read, and must never be redirected by whatever
 * happens to be configured on a developer machine.
 */
export async function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stored?: StoredCredentials,
  readKey: (path: string) => Promise<Buffer> = path => readFile(path)
): Promise<AppConfig> {
  const host = env['KEENETIC_HOST'] ?? flagValue(argv, '--host') ?? stored?.host;
  const password = env['KEENETIC_PASSWORD'] ?? stored?.password;
  const login = env['KEENETIC_USER'] ?? stored?.login ?? 'admin';

  const rawMax = flagValue(argv, '--max-response-bytes');
  const parsedMax = rawMax === undefined ? DEFAULT_MAX_RESPONSE_BYTES : Number.parseInt(rawMax, 10);
  if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
    throw new Error(`--max-response-bytes must be a positive integer, got "${rawMax}"`);
  }

  if (!host || !password) {
    throw new Error(
      'No router configured. Run "node dist/index.js init" to set one up, or set ' +
        'KEENETIC_HOST and KEENETIC_PASSWORD in the environment.'
    );
  }

  // Shell access is opt-in: an agent with an arbitrary command runner is a
  // different risk class than one with curated tools, so the default is off.
  // Answering "yes" to it in `init` is the same opt-in as --ssh, and
  // KEENETIC_SSH=0 switches a stored setup off again without touching it.
  const envSsh = (env['KEENETIC_SSH'] ?? '').trim().toLowerCase();
  const sshEnabled = FALSY.includes(envSsh)
    ? false
    : argv.includes('--ssh') || TRUTHY.includes(envSsh) || stored?.ssh !== undefined;

  let ssh: SshConfig | null = null;
  if (sshEnabled) {
    const port = parsePort(
      env['KEENETIC_SSH_PORT'] ?? flagValue(argv, '--ssh-port') ?? stored?.ssh?.port ?? DEFAULT_SSH_PORT
    );
    const user = env['KEENETIC_SSH_USER'] ?? stored?.ssh?.user ?? DEFAULT_SSH_USER;
    const keyPath = env['KEENETIC_SSH_KEY'] ?? flagValue(argv, '--ssh-key') ?? stored?.ssh?.keyPath;
    const sshPassword = env['KEENETIC_SSH_PASSWORD'] ?? stored?.ssh?.password;

    ssh = { port, user };
    if (keyPath) {
      const resolved = expandHome(keyPath);
      try {
        ssh.privateKey = await readKey(resolved);
      } catch (error) {
        throw new Error(
          `Cannot read the SSH key ${resolved}: ${(error as Error).message}. Fix KEENETIC_SSH_KEY ` +
            'or re-run "node dist/index.js init".'
        );
      }
      ssh.keyPath = resolved;
      const passphrase = env['KEENETIC_SSH_KEY_PASSPHRASE'] ?? stored?.ssh?.passphrase;
      if (passphrase) ssh.passphrase = passphrase;
    } else if (sshPassword !== undefined && sshPassword !== '') {
      ssh.password = sshPassword;
    } else if (user === login) {
      // The one case where the router password is the right one: logging into
      // the KeeneticOS SSH server with the router's own account.
      ssh.password = password;
    } else {
      throw new Error(
        `SSH is enabled for ${user}@${host}:${String(port)} but no password or key is set. ` +
          'Run "node dist/index.js init" and answer the SSH questions, or set ' +
          'KEENETIC_SSH_PASSWORD or KEENETIC_SSH_KEY (Entware default: root / keenetic, ' +
          'which you should change).'
      );
    }
  }

  return {
    host,
    login,
    password,
    readOnly: argv.includes('--read-only'),
    maxResponseBytes: parsedMax,
    ssh
  };
}
