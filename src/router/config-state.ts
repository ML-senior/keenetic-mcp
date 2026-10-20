import type { Rci } from './rci.js';

/** Where the router serves the saved configuration. Three callers need the path. */
export const STARTUP_CONFIG = '/ci/startup-config.txt';

/** The router stamps the saved configuration with its own checksum, in a header comment. */
const SAVED_CHECKSUM = /^!\s*\$+\s*Md5 checksum:\s*([0-9a-f]{32})/im;
/** ...and with the time of the change it saved: `! $$$ Last change: Sun, 18 Oct 2026 17:24:08 GMT`. */
const SAVED_LAST_CHANGE = /^!\s*\$+\s*Last change:\s*(.+?)\s*$/im;

function parseDate(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value.replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface LastChange {
  date: string | null;
  user: string | null;
  agent: string | null;
  /** Moves when the configuration changes, and again when it is saved. */
  checksum: string | null;
  failSafe: { unsaved: boolean; rollbackPending: boolean; secondsLeft: unknown };
}

/** What `get_config_state` returns. Named for the reader, not for the wire. */
export interface ConfigState {
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  lastChangedVia: string | null;
  runningChecksum: string | null;
  savedChecksum: string | null;
  /** The `Last change` stamped into startup-config.txt when it was saved. */
  savedLastChangeAt: string | null;
  /**
   * How the answer was reached. `content` means the stamps disagreed and the
   * two configurations were compared line by line, which is authoritative.
   */
  basis: 'stamps' | 'content';
  /** null when the saved state could not be read - never a guess. */
  unsavedChanges: boolean | null;
  failSafe: { unsaved: boolean; rollbackPending: boolean; secondsLeft: unknown };
}

/**
 * The cheap half: a small JSON document, against ~17 KB for the startup config.
 * Enough to see that the router has acted, not enough to prove what it wrote.
 */
export async function readLastChange(rci: Rci): Promise<LastChange> {
  const raw = asRecord(await rci.get('show/last-change'));
  const failSafe = asRecord(raw['fail-safe']);
  return {
    date: asString(raw['date']),
    user: asString(raw['user']),
    agent: asString(raw['agent']),
    checksum: asString(raw['checksum']),
    failSafe: {
      unsaved: failSafe['unsaved'] === true,
      rollbackPending: failSafe['rollback'] === true,
      secondsLeft: failSafe['time-left'] ?? 0
    }
  };
}

/** True once the router has recorded something since `before` was taken. */
export function lastChangeMoved(before: LastChange, after: LastChange): boolean {
  return before.checksum !== after.checksum || before.date !== after.date;
}

/**
 * The configuration without its `! $$$` header, trailing whitespace and the
 * names given with `rename`.
 *
 * The two sources spell references differently. startup-config.txt writes the
 * user's names (`role inet for ISP`, `include AccessPoint`, `ip nat Home`);
 * RCI's `show running-config` writes the system ids for the very same lines
 * (`GigabitEthernet1`, `WifiMaster0/AccessPoint0`, `Bridge0`). Measured on 5.2:
 * byte-identical configurations, four differing lines. `aliases` maps a
 * renamed name to its id, and every whole word that is an alias is rewritten
 * to the id - except on the `rename` line itself, which both sources share.
 */
export function configBody(text: string, aliases: ReadonlyMap<string, string> = new Map()): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => !/^!\s*\$+/.test(line))
    .map(line => line.replace(/\s+$/, ''))
    .map(line =>
      aliases.size === 0 || /^\s*rename\s/.test(line)
        ? line
        : line.replace(/[^\s]+/g, word => aliases.get(word) ?? word)
    )
    .join('\n')
    .trim();
}

/**
 * Renamed name -> interface id, from the interface tree. Numeric names (the
 * switch ports are renamed to "0".."4") are left out: a bare number appears in
 * far too many unrelated lines to rewrite safely, and a missed alias can only
 * make the comparison report a difference, never hide one.
 */
export async function readInterfaceAliases(rci: Rci): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  try {
    const tree = asRecord(await rci.get('show/rc/interface'));
    for (const [id, value] of Object.entries(tree)) {
      const rename = asRecord(value)['rename'];
      if (typeof rename === 'string' && rename !== id && !/^\d+$/.test(rename)) aliases.set(rename, id);
    }
  } catch {
    // Without aliases the comparison only errs towards "unsaved".
  }
  return aliases;
}

/** `show running-config` as text, or null if it could not be read. */
export async function readRunningConfig(rci: Rci): Promise<string | null> {
  try {
    const raw = (await rci.post({ show: { 'running-config': {} } })) as Record<string, unknown>;
    const show = (raw?.['show'] ?? {}) as Record<string, unknown>;
    const message = ((show['running-config'] ?? {}) as Record<string, unknown>)['message'];
    return Array.isArray(message) ? message.map(String).join('\n') : null;
  } catch {
    return null;
  }
}

/**
 * Whether the running configuration still differs from the one in flash.
 *
 * `show/last-change` carries a `fail-safe.unsaved` flag that reads like the
 * answer and is not: it tracks the fail-safe rollback timer, not the saved
 * state. Measured on KeeneticOS 5.1.1, three objects were removed over RCI and
 * the flag stayed `false` throughout, while startup-config.txt was still
 * byte-for-byte the old one - a reboot would have restored everything.
 *
 * Nor is the checksum alone enough. Measured on 5.2 Alpha 11: an interface
 * removed over RCI moved `date` but left `checksum` at the saved value until
 * `system configuration save` ran. So a change is reported as unsaved when
 * either the checksum differs or the running change is newer than the
 * `Last change` the router wrote into the saved file.
 */
export async function readConfigState(rci: Rci): Promise<ConfigState> {
  const last = await readLastChange(rci);

  let savedChecksum: string | null = null;
  let savedLastChange: string | null = null;
  let startupText: string | null = null;
  try {
    const text = await rci.getText(STARTUP_CONFIG);
    startupText = text;
    savedChecksum = SAVED_CHECKSUM.exec(text)?.[1] ?? null;
    savedLastChange = SAVED_LAST_CHANGE.exec(text)?.[1] ?? null;
  } catch {
    // Reporting "saved" on a failed read would be the very error this replaces.
    savedChecksum = null;
  }

  const runningAt = parseDate(last.date);
  const savedAt = parseDate(savedLastChange);
  const newerThanSaved = runningAt !== null && savedAt !== null ? runningAt > savedAt : null;
  const checksumDiffers =
    last.checksum !== null && savedChecksum !== null ? last.checksum !== savedChecksum : null;

  let unsavedChanges: boolean | null;
  if (checksumDiffers === true || newerThanSaved === true) unsavedChanges = true;
  else if (checksumDiffers === null && newerThanSaved === null) unsavedChanges = null;
  // A matching checksum with no date to compare is the old, weaker answer;
  // keep it rather than claiming not to know.
  else unsavedChanges = false;

  // The stamps over-report. The checksum covers the header too, so a cloud or
  // mobile-app session that touches nothing still moves `Last change` and the
  // checksum - and a save then changes nothing on flash, because the router
  // does not rewrite an identical body. Measured on 5.2: "configuration saved"
  // in the log, startup-config.txt untouched, stamps still disagreeing.
  // When they say "unsaved", compare the configurations themselves.
  let basis: ConfigState['basis'] = 'stamps';
  if (unsavedChanges === true && startupText !== null) {
    const running = await readRunningConfig(rci);
    if (running !== null) {
      basis = 'content';
      const aliases = await readInterfaceAliases(rci);
      unsavedChanges = configBody(running, aliases) !== configBody(startupText, aliases);
    }
  }

  return {
    lastChangedAt: last.date,
    lastChangedBy: last.user,
    lastChangedVia: last.agent,
    runningChecksum: last.checksum,
    savedChecksum,
    savedLastChangeAt: savedLastChange,
    unsavedChanges,
    basis,
    failSafe: last.failSafe
  };
}
