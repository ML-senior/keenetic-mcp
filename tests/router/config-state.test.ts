import { describe, expect, it, vi } from 'vitest';
import { readConfigState } from '../../src/router/config-state.js';
import type { Rci } from '../../src/router/rci.js';

function rci(lastChange: Record<string, unknown>, startup: string | Error): Rci {
  return {
    get: vi.fn(async () => lastChange),
    post: vi.fn(),
    getText: vi.fn(async () => {
      if (startup instanceof Error) throw startup;
      return startup;
    })
  } as unknown as Rci;
}

const header = (date: string, sum: string): string =>
  `! $$$ Agent: http/rci\n! $$$ Last change: ${date}\n! $$$ Md5 checksum: ${sum}\n! $$$ Model: Keenetic Ultra\n`;

const A = '61b5c84548b3e6013f1a1a8fbd7d0e68';
const B = 'c63cb63f802e3ec8c62340d98ec20bef';

describe('readConfigState', () => {
  it('reports saved when date and checksum match the file', async () => {
    const state = await readConfigState(
      rci({ date: 'Sun, 18 Oct 2026 19:20:54 GMT', checksum: B }, header('Sun, 18 Oct 2026 19:20:54 GMT', B))
    );
    expect(state.unsavedChanges).toBe(false);
    expect(state.savedLastChangeAt).toBe('Sun, 18 Oct 2026 19:20:54 GMT');
  });

  /**
   * Captured on KeeneticOS 5.2 Alpha 11: `no interface Wireguard0` over RCI moved
   * the last-change date but left the checksum at the saved value until save.
   */
  it('reports unsaved when only the date has moved', async () => {
    const state = await readConfigState(
      rci({ date: 'Sun, 18 Oct 2026 19:19:56 GMT', checksum: A }, header('Sun, 18 Oct 2026 17:24:08 GMT', A))
    );
    expect(state.runningChecksum).toBe(state.savedChecksum);
    expect(state.unsavedChanges).toBe(true);
  });

  it('copes with the double space the router puts in single-digit days', async () => {
    const state = await readConfigState(
      rci({ date: 'Thu,  6 Aug 2026 10:46:01 GMT', checksum: A }, header('Thu, 6 Aug 2026 10:46:01 GMT', A))
    );
    expect(state.unsavedChanges).toBe(false);
  });

  it('still reports unsaved on a checksum change alone', async () => {
    const state = await readConfigState(
      rci({ date: 'Sun, 18 Oct 2026 17:24:08 GMT', checksum: B }, header('Sun, 18 Oct 2026 17:24:08 GMT', A))
    );
    expect(state.unsavedChanges).toBe(true);
  });

  it('says it does not know when the saved file cannot be read', async () => {
    const state = await readConfigState(rci({ date: 'x', checksum: A }, new Error('boom')));
    expect(state.unsavedChanges).toBeNull();
  });
});
