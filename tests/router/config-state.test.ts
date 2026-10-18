import { describe, expect, it, vi } from 'vitest';
import { readConfigState } from '../../src/router/config-state.js';
import type { Rci } from '../../src/router/rci.js';

function rci(lastChange: Record<string, unknown>, startup: string | Error, running?: string): Rci {
  return {
    get: vi.fn(async () => lastChange),
    post: vi.fn(async () =>
      running === undefined ? {} : { show: { 'running-config': { message: running.split('\n') } } }
    ),
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

  /**
   * Captured on 5.2: a mobile-app session moved the stamps 12 s after a save
   * without changing anything. The router then refused to rewrite the
   * identical body, so the stamps disagreed forever.
   */
  it('compares the bodies when only the stamps disagree', async () => {
    const body = 'system\n    hostname r\n!\nip ssh\n    port 2022\n!';
    const state = await readConfigState(
      rci(
        { date: 'Sun, 18 Oct 2026 21:40:25 GMT', checksum: B, agent: 'coala/rci' },
        header('Sun, 18 Oct 2026 21:40:13 GMT', A) + '\n' + body + '\n',
        `! $$$ Agent: coala/rci\n! $$$ Last change: Sun, 18 Oct 2026 21:40:25 GMT\n! $$$ Md5 checksum: ${B}\n\n${body}\n`
      )
    );
    expect(state.unsavedChanges).toBe(false);
    expect(state.basis).toBe('content');
  });

  it('still reports unsaved when the bodies really differ', async () => {
    const state = await readConfigState(
      rci(
        { date: 'Sun, 18 Oct 2026 21:40:25 GMT', checksum: B },
        header('Sun, 18 Oct 2026 21:40:13 GMT', A) + 'ip static tcp PPPoE0 3000 x\n',
        '! $$$ Agent: http/rci\nsomething else\n'
      )
    );
    expect(state.unsavedChanges).toBe(true);
    expect(state.basis).toBe('content');
  });

  it('keeps the stamp answer when the running config cannot be read', async () => {
    const state = await readConfigState(
      rci({ date: 'Sun, 18 Oct 2026 21:40:25 GMT', checksum: B }, header('Sun, 18 Oct 2026 21:40:13 GMT', A))
    );
    expect(state.unsavedChanges).toBe(true);
    expect(state.basis).toBe('stamps');
  });

  it('says it does not know when the saved file cannot be read', async () => {
    const state = await readConfigState(rci({ date: 'x', checksum: A }, new Error('boom')));
    expect(state.unsavedChanges).toBeNull();
  });
});
