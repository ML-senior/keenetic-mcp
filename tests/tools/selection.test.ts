import { describe, expect, it } from 'vitest';
import { parseToolSelection } from '../../src/tools/selection.js';

describe('parseToolSelection', () => {
  it('means everything for nothing or "all"', () => {
    expect(parseToolSelection(undefined)).toBeNull();
    expect(parseToolSelection('')).toBeNull();
    expect(parseToolSelection('core,all')).toBeNull();
  });

  it('expands profiles, names and globs', () => {
    const allow = parseToolSelection(' core , ssh_* ,list_routes')!;
    expect(allow('set_port_forwarding')).toBe(true);
    expect(allow('ssh_exec')).toBe(true);
    expect(allow('list_routes')).toBe(true);
    expect(allow('create_segment')).toBe(false);
  });

  it('refuses a typo instead of silently serving nothing', () => {
    expect(() => parseToolSelection('cor e')).toThrow(/Unknown tool selection/);
  });
});
