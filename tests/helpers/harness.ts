import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import type { KeeneticClient } from '../../src/router/client.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import { stubBackup } from './backup.js';

export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface Rig {
  handlers: Record<string, Handler>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  ctx: ToolContext;
}

export interface RigOptions {
  /** Answers for GET by path; a missing path throws like a 404 would. */
  get?: Record<string, unknown> | ((path: string) => unknown);
  post?: (body: unknown) => unknown;
  getText?: (path: string) => string;
  readOnly?: boolean;
  maxResponseBytes?: number;
  connect?: (host: string) => KeeneticClient;
}

/** Registers a group of tools against a scripted router and hands back the handlers. */
export function rig(register: (server: McpServer, ctx: ToolContext) => void, opts: RigOptions = {}): Rig {
  const get = vi.fn(async (path: string) => {
    if (typeof opts.get === 'function') return opts.get(path);
    const table = opts.get ?? {};
    if (!(path in table)) throw new Error(`this path does not exist on this firmware: ${path}`);
    return table[path];
  });
  const post = vi.fn(async (body: unknown) => (opts.post ? opts.post(body) : {}));
  const getText = vi.fn(async (path: string) => {
    if (!opts.getText) throw new Error(`no such text path: ${path}`);
    return opts.getText(path);
  });
  const client = { rci: { get, post, getText }, capabilities: vi.fn() } as unknown as KeeneticClient;

  const ctx: ToolContext = {
    client,
    maxResponseBytes: opts.maxResponseBytes ?? 25_000,
    readOnly: opts.readOnly ?? false,
    backup: stubBackup()
  };
  if (opts.connect) ctx.connect = opts.connect;

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((name: string, _config: unknown, handler: Handler) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);
  register(server, ctx);
  return { handlers, get, post, getText, ctx };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

export function text(result: ToolResult): string {
  return result.content.map(p => p.text).join('');
}
