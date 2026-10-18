export interface SshConfig {
  port: number;
  user: string;
  password: string;
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

export interface StoredCredentials {
  host?: string;
  login?: string;
  password?: string;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 25_000;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
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
  stored?: StoredCredentials
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
      'No router configured. Run "npx keenetic-mcp init" to set one up, or set ' +
        'KEENETIC_HOST and KEENETIC_PASSWORD in the environment.'
    );
  }

  // Shell access is opt-in: an agent with an arbitrary command runner is a
  // different risk class than one with curated tools, so the default is off.
  const sshEnabled =
    argv.includes('--ssh') || ['1', 'true', 'yes'].includes(env['KEENETIC_SSH'] ?? '');
  let ssh: SshConfig | null = null;
  if (sshEnabled) {
    const rawPort = env['KEENETIC_SSH_PORT'] ?? flagValue(argv, '--ssh-port') ?? '22';
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`SSH port must be 1-65535, got "${rawPort}"`);
    }
    ssh = {
      port,
      user: env['KEENETIC_SSH_USER'] ?? login,
      password: env['KEENETIC_SSH_PASSWORD'] ?? password
    };
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
