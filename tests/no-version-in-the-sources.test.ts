import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEV_VERSION } from '../src/version.js';

const ROOT = new URL('../', import.meta.url);

async function json<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, ROOT), 'utf8')) as T;
}

/**
 * A release is a tag and nothing else.
 *
 * The version used to be repeated in five files and kept in step by a script
 * on npm's `version` lifecycle hook, which meant every release began with a
 * commit whose only purpose was to write that number down five times. Now
 * package.json holds a placeholder, the release workflow stamps the real
 * version from the tag just before publishing without committing it, and the
 * plugin manifests carry no version at all.
 *
 * That only holds while nothing writes one back. Manifests are hand-edited and
 * a version field is the obvious thing to add, so this fails when one appears.
 */
describe('no version is written down in the sources', () => {
  it('package.json carries the placeholder, not a release', async () => {
    const pkg = await json<{ version: string }>('package.json');
    expect(pkg.version).toBe(DEV_VERSION);
  });

  /**
   * server.json repeats the version twice, and the MCP registry rejects a
   * server whose version disagrees with the package it points at. The release
   * workflow stamps both from the tag, so both have to be placeholders here.
   */
  it('server.json carries the placeholder in both places', async () => {
    const server = await json<{ version: string; packages: { version: string }[] }>('server.json');
    expect(server.version).toBe(DEV_VERSION);
    expect(server.packages[0]?.version).toBe(DEV_VERSION);
  });

  /**
   * The registry proves ownership by fetching the published package and
   * matching its `mcpName` against the server name. A mismatch is only visible
   * at publish time, which is after npm has already accepted the release.
   */
  it('the registry name matches the one the package claims', async () => {
    const pkg = await json<{ mcpName: string; name: string }>('package.json');
    const server = await json<{ name: string; packages: { identifier: string }[] }>('server.json');

    expect(pkg.mcpName).toBe(server.name);
    expect(server.packages[0]?.identifier).toBe(pkg.name);
  });

  // npm ci refuses a lock file that disagrees with package.json, so a stale
  // version here breaks every install rather than just the release.
  it('the lock file agrees with it', async () => {
    const lock = await json<{ version: string; packages: Record<string, { version?: string }> }>(
      'package-lock.json'
    );
    expect(lock.version).toBe(DEV_VERSION);
    expect(lock.packages['']?.version).toBe(DEV_VERSION);
  });

  // Read straight from the repository by Claude Code and Codex at install
  // time, never built and never published, so there is no point in the build
  // where a version could be stamped into them. The field is optional; the
  // official Anthropic plugins omit it too.
  it.each([
    ['plugins/keenetic/.claude-plugin/plugin.json', 'the Claude plugin'],
    ['plugins/keenetic/.codex-plugin/plugin.json', 'the Codex plugin']
  ])('%s declares no version', async path => {
    const manifest = await json<Record<string, unknown>>(path);
    expect(manifest['version'], `${path} must not pin a version`).toBeUndefined();
  });

  it.each([
    ['.claude-plugin/marketplace.json', 'Claude Code'],
    ['.agents/plugins/marketplace.json', 'Codex']
  ])('the %s catalogue declares no version', async path => {
    const marketplace = await json<{ plugins: Record<string, unknown>[] }>(path);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
    for (const entry of marketplace.plugins) {
      expect(entry['version'], `${path} must not pin a version`).toBeUndefined();
    }
  });

  /**
   * This fork is not published to npm, so the plugin runs the locally built
   * server. The assertion that matters here is that the launcher carries no
   * version-shaped string at all.
   */
  it('the plugins launch the local build and pin nothing', async () => {
    const mcp = await json<{ mcpServers: Record<string, { args: string[] }> }>(
      'plugins/keenetic/.mcp.json'
    );
    const args = mcp.mcpServers['keenetic']?.args ?? [];
    expect(args.at(-1)).toContain('dist/index.js');
    for (const arg of args) {
      expect(arg, `argument "${arg}" must not look like a version pin`).not.toMatch(/@\^?\d/);
    }
  });
});
