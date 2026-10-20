import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

export function gatewayCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'route', args: ['-n', 'get', 'default'] };
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0).NextHop']
    };
  }
  return { command: 'ip', args: ['route', 'show', 'default'] };
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

export function parseGateway(platform: NodeJS.Platform, stdout: string): string | null {
  if (platform === 'darwin') {
    const line = stdout.split('\n').find(l => l.trim().startsWith('gateway:'));
    return line?.match(IPV4)?.[1] ?? null;
  }
  if (platform === 'win32') {
    return stdout.match(IPV4)?.[1] ?? null;
  }
  const line = stdout.split('\n').find(l => l.startsWith('default'));
  return line?.match(IPV4)?.[1] ?? null;
}

/**
 * Confirms a host is a Keenetic by asking for /auth and reading the realm,
 * which is the same signal the session layer authenticates against. Anything
 * else answering on port 80 will not carry that header.
 */
export async function identifyRouter(
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ realm: string } | null> {
  try {
    const res = await fetchImpl(`http://${host}/auth`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'manual'
    });
    const realm = res.headers.get('X-NDM-Realm');
    return realm ? { realm } : null;
  } catch {
    return null;
  }
}

export function configDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const override = env['KEENETIC_CONFIG_DIR'];
  if (override) return override;

  const home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
  if (platform === 'win32') return win32.join(env['APPDATA'] ?? home, 'keenetic-mcp');
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'keenetic-mcp');
  }
  return posix.join(env['XDG_CONFIG_HOME'] ?? posix.join(home, '.config'), 'keenetic-mcp');
}

/**
 * The router address as SSH and raw sockets need it: no scheme, no path, no
 * HTTP port. The router address is an HTTP address and may carry a port
 * ("192.168.1.1:8080" once the web UI is moved off 80); handing that to SSH
 * makes getaddrinfo look up a host literally named "192.168.1.1:8080".
 * Bracketed IPv6 ("[fd00::1]:8080") keeps its address.
 */
export function sshHost(address: string): string {
  const withoutScheme = address.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split(/[/?#]/)[0] ?? '';
  const withoutUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const bracketed = /^\[([^\]]+)\]/.exec(withoutUser);
  if (bracketed) return bracketed[1]!;
  // A bare IPv6 address has several colons and no port to strip.
  if ((withoutUser.match(/:/g) ?? []).length > 1) return withoutUser;
  return withoutUser.split(':')[0]!;
}

export interface StoredSshConfig {
  port: number;
  user: string;
  auth: 'password' | 'key';
  /** Only for auth=key. The key stays where it is; only its path is recorded. */
  keyPath?: string;
}

export interface StoredConfig {
  host: string;
  login: string;
  /** Present only when shell access was enabled in `init`. */
  ssh?: StoredSshConfig;
}

const FILE = 'config.json';

function parseSsh(value: unknown): StoredSshConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const port = typeof raw['port'] === 'number' ? raw['port'] : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof raw['user'] !== 'string' || raw['user'] === '') return undefined;
  const auth = raw['auth'] === 'key' ? 'key' : 'password';
  const ssh: StoredSshConfig = { port, user: raw['user'], auth };
  if (auth === 'key') {
    if (typeof raw['keyPath'] !== 'string' || raw['keyPath'] === '') return undefined;
    ssh.keyPath = raw['keyPath'];
  }
  return ssh;
}

export async function readStoredConfig(dir: string): Promise<StoredConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, FILE), 'utf8')) as Record<string, unknown>;
    if (typeof parsed['host'] !== 'string' || typeof parsed['login'] !== 'string') return null;
    const config: StoredConfig = { host: parsed['host'], login: parsed['login'] };
    const ssh = parseSsh(parsed['ssh']);
    if (ssh) config.ssh = ssh;
    return config;
  } catch {
    return null;
  }
}

/** Keychain account names. One place, so init and the server never disagree. */
export const secretAccounts = {
  router: (login: string, host: string): string => `${login}@${host}`,
  sshPassword: (user: string, host: string): string => `ssh:${user}@${host}`,
  sshPassphrase: (user: string, host: string): string => `ssh-key:${user}@${host}`
};

/**
 * JSON rather than TOML: Node has no built-in parser and a handful of fields do
 * not justify a dependency. No secret is ever written here; passwords and key
 * passphrases live in the keychain, keyed by `secretAccounts`.
 */
export async function writeStoredConfig(dir: string, config: StoredConfig): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);
  const out: Record<string, unknown> = { host: config.host, login: config.login };
  if (config.ssh) {
    const ssh: Record<string, unknown> = {
      port: config.ssh.port,
      user: config.ssh.user,
      auth: config.ssh.auth
    };
    if (config.ssh.auth === 'key') ssh['keyPath'] = config.ssh.keyPath;
    out['ssh'] = ssh;
  }
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return path;
}
