// Tool registration in tiers. Each tier is on, ask or off: on registers the tool as usual, ask
// marks it so Claude Code prompts on every call, off leaves it out of tools/list altogether.
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type Tier = 'read' | 'write' | 'delete';
export type Product = 'Jira' | 'Confluence';
export type Setting = 'on' | 'ask' | 'off';
export const SETTINGS: readonly Setting[] = ['on', 'ask', 'off'];

// Every tool talks to the one configured host, so none is open-world.
const HINTS: Record<Tier, ToolAnnotations> = {
  read: { readOnlyHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

// Claude Code prompts on every call of a tool carrying this, in every permission mode.
const ASK = { 'anthropic/requiresUserInteraction': true };

export const reply = (output: string): CallToolResult => ({ content: [{ type: 'text', text: output }] });

export interface ToolConfig<Input> {
  description: string;
  inputSchema: Input;
  /** Set on a write that leaves things the same when repeated, such as adding a label twice. */
  idempotent?: boolean;
}

// Reads and writes run as Claude Code's own permissions allow; a delete asks every time.
const DEFAULTS: Record<Tier, Setting> = { read: 'on', write: 'on', delete: 'ask' };

/** The tier's setting from `<PRODUCT>_<TIER>`; an unset or unsubstituted option means the default. */
function setting(tier: Tier, variable: string): Setting {
  const value = (process.env[variable] ?? '').trim().toLowerCase();
  if (SETTINGS.includes(value as Setting)) return value as Setting;
  if (value && !value.includes('${')) console.error(`${variable}='${value}' is not on, ask or off; using ${DEFAULTS[tier]}.`);
  return DEFAULTS[tier];
}

export function registrar(server: McpServer, product: Product) {
  const prefix = product.toUpperCase();
  const settings: Record<Tier, Setting> = {
    read: setting('read', `${prefix}_READ`),
    write: setting('write', `${prefix}_WRITE`),
    delete: setting('delete', `${prefix}_DELETE`),
  };

  function tool<Input extends ZodRawShapeCompat | AnySchema>(tier: Tier, name: string, config: ToolConfig<Input>, handler: ToolCallback<Input>) {
    if (settings[tier] === 'off') return;
    const annotations = { ...HINTS[tier], ...(config.idempotent && { idempotentHint: true }) };
    const _meta = settings[tier] === 'ask' ? ASK : undefined;
    server.registerTool(name, { description: config.description, inputSchema: config.inputSchema, annotations, _meta }, handler);
  }

  return { tool, settings };
}
export type Tool = ReturnType<typeof registrar>['tool'];
