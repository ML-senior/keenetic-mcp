/**
 * Commands this server will never send to the router, no matter how they are
 * reached. The list is deliberately short and obvious: a shell cannot be made
 * safe by pattern matching, so this is the last line of defence, not the
 * first. The first is that SSH tools exist at all only when explicitly
 * enabled with --ssh / KEENETIC_SSH=1.
 */
const BLOCKED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/?(\s|$)/,
    why: 'recursive/forced delete of the filesystem root'
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/opt\/?(\s|$)/,
    why: 'deleting /opt removes Entware itself'
  },
  { pattern: /\bmkfs/, why: 'formats a filesystem' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, why: 'raw write to a block device' },
  { pattern: /\b(mtd|flash_erase|nandwrite|sysupgrade|firstboot)\b/, why: 'writes firmware or flash' },
  {
    pattern: /^\s*(reboot|halt|poweroff|shutdown)\b/m,
    why: 'rebooting belongs to the reboot_router tool, which checks for unsaved changes first'
  },
  {
    pattern: /^\s*passwd\b/m,
    why: 'changing the SSH password would lock this server (and possibly you) out'
  }
];

export interface SshBlock {
  blocked: true;
  reason: string;
}

export function checkCommand(command: string): SshBlock | null {
  for (const { pattern, why } of BLOCKED) {
    if (pattern.test(command)) {
      return { blocked: true, reason: `Refused: ${why}.` };
    }
  }
  return null;
}

/**
 * Where ssh_write_file may write. Configurations the user is meant to edit
 * live under /opt (Entware); /tmp is scratch. Anything else - router flash
 * layout, system files - is edited from a real terminal, not through an agent.
 */
export function checkWritablePath(path: string): SshBlock | null {
  if (!path.startsWith('/opt/') && !path.startsWith('/tmp/')) {
    return {
      blocked: true,
      reason: `Refused: writes are limited to /opt/ and /tmp/, got '${path}'.`
    };
  }
  if (path.includes('\n') || path.includes("'") || path.includes('..')) {
    return { blocked: true, reason: `Refused: '${path}' is not a plain absolute path.` };
  }
  return null;
}

export function checkReadablePath(path: string): SshBlock | null {
  if (!path.startsWith('/') || path.includes('\n') || path.includes("'") || path.includes('..')) {
    return { blocked: true, reason: `Refused: '${path}' is not a plain absolute path.` };
  }
  return null;
}
