/**
 * Newsroom MCP — WebMCP v1 surface (Phase 6).
 *
 * Exposes the studio's proven Studio-Bridge handlers as a *generic*, uniform
 * WebMCP v1 tool surface — one tool per {@link BRIDGE_COMMANDS} entry. Unlike
 * the curated tool modules (`perform.ts`, `timeline.ts`, …) which hand-shape
 * each tool, this module is **data-driven**: it enumerates the
 * {@link BridgeCommand} discriminated union and derives a tool from each
 * variant's `params` schema, so the WebMCP surface can never drift out of sync
 * with the wire contract.
 *
 * Each tool:
 *   - names itself `webmcp_<cmd>` (the `webmcp_` prefix avoids colliding with
 *     the curated tools' names like `set_headline`),
 *   - accepts the command's params under a single `params` key, whose schema is
 *     the exact variant from `@las/protocol`'s `BridgeCommand` union,
 *   - validates the assembled `{ cmd, params }` with {@link parseBridgeCommand}
 *     (so bad args fail loudly — no retries, per project policy), then
 *   - forwards to the connected studio via the existing {@link callBridge}
 *     transport and maps the `BridgeResult` payload back as a text result.
 *
 * This wraps the *existing* dispatch handlers — it does NOT reimplement any
 * studio logic. When Phase 5's Score runtime is fully live, the handler under
 * `applyNewscast`/`setScript`/… changes; this tool surface does not.
 */

import { z, type ZodRawShape } from 'zod';
import {
  BridgeCommand,
  BRIDGE_COMMANDS,
  parseBridgeCommand,
  type BridgeCommandName,
} from '@las/protocol';
import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

function asText(result: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
}

/**
 * The params Zod schema for each bridge command, indexed by `cmd`. Built once
 * from the {@link BridgeCommand} discriminated union so it stays in lockstep
 * with the wire contract — every variant carries `{ cmd: literal, params }`.
 */
const PARAMS_BY_CMD: Partial<Record<BridgeCommandName, z.ZodTypeAny>> = (() => {
  const map: Partial<Record<BridgeCommandName, z.ZodTypeAny>> = {};
  for (const option of BridgeCommand.options) {
    const shape = option.shape;
    // `cmd` is a ZodLiteral<cmdName>; `.value` is the literal string.
    const cmd = shape.cmd.value as BridgeCommandName;
    map[cmd] = shape.params;
  }
  return map;
})();

/**
 * Build one WebMCP tool per bridge command. The `inputSchema` is a raw shape
 * with a single `params` key bound to the command's exact params schema, so the
 * SDK validates args against the real contract before our handler runs.
 */
function buildWebmcpTools(): ToolDef<ZodRawShape>[] {
  const tools: ToolDef<ZodRawShape>[] = [];
  for (const cmd of BRIDGE_COMMANDS) {
    const paramsSchema = PARAMS_BY_CMD[cmd];
    if (!paramsSchema) continue; // unreachable: every command has a variant
    const inputSchema: ZodRawShape = {
      params: paramsSchema.describe(`Params for the "${cmd}" Studio Bridge command`),
    };
    tools.push(
      defineTool({
        name: `webmcp_${cmd}`,
        title: `WebMCP: ${cmd}`,
        description:
          `WebMCP v1 wrapper for the "${cmd}" Studio Bridge command. Validates ` +
          `\`params\` against the @las/protocol BridgeCommand contract and forwards ` +
          `it to the connected avatar-live studio, returning the bridge result.`,
        inputSchema,
        async handler(args) {
          // Assemble + validate the full command envelope against the wire
          // contract (throws ZodError on bad params — surfaced loudly).
          const command = parseBridgeCommand({ cmd, params: (args as { params: unknown }).params });
          return asText(await callBridge(command.cmd, command.params));
        },
      }),
    );
  }
  return tools;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const webmcpTools: ToolDef<any>[] = buildWebmcpTools();
