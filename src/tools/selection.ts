import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Named tool sets, so an agent is not sent every tool description on every
 * request. The full list is ~8k tokens; most agents need a fraction of it.
 */
export const TOOL_PROFILES: Record<string, readonly string[]> = {
  /** Day-to-day: who is online, is the internet up, forward a port, publish a name. */
  core: [
    'get_system_info',
    'get_internet_status',
    'get_config_state',
    'save_config',
    'list_devices',
    'get_device',
    'update_device',
    'get_wifi_status',
    'get_port_forwarding',
    'set_port_forwarding',
    'remove_port_forwarding',
    'get_keendns_mappings',
    'set_keendns_mapping',
    'remove_keendns_mapping',
    'get_log'
  ],
  /** Everything that only reads. Same as --read-only, minus nothing. */
  read: ['get_*', 'list_*', 'run_ping', 'backup_config', 'ssh_check'],
  /** Entware work. */
  shell: ['ssh_*', 'opkg_manage', 'get_media', 'get_opkg_status', 'get_log', 'get_config_state']
};

function toMatcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes('*')) return name => name === pattern;
  const re = new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return name => re.test(name);
}

/**
 * Parses `--tools` / KEENETIC_TOOLS: comma-separated profile names, tool names
 * and globs ("core,ssh_*"). Returns null for "all" or nothing, meaning no filter.
 */
export function parseToolSelection(raw: string | undefined): ((name: string) => boolean) | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0 || parts.includes('all')) return null;

  const matchers: Array<(name: string) => boolean> = [];
  for (const part of parts) {
    const profile = TOOL_PROFILES[part];
    if (profile) matchers.push(...profile.map(toMatcher));
    else if (/^[a-z0-9_*]+$/.test(part)) matchers.push(toMatcher(part));
    else {
      throw new Error(
        `Unknown tool selection "${part}". Use all, ${Object.keys(TOOL_PROFILES).join(', ')}, ` +
          'a tool name or a glob such as ssh_*.'
      );
    }
  }
  return name => matchers.some(match => match(name));
}

/**
 * Wraps a server so registerTool silently skips tools outside the selection.
 * The register* modules stay unaware of it.
 */
export function selectingServer(server: McpServer, allow: (name: string) => boolean): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          if (!allow(name)) return undefined;
          return (target.registerTool as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  });
}
