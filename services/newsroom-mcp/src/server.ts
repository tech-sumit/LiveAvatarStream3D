#!/usr/bin/env node
/**
 * Newsroom MCP server (stdio).
 *
 * A Model Context Protocol server that drives an avatar-live studio over the
 * Studio Bridge WS protocol (see `@las/protocol`'s `bridge.ts`). An MCP client
 * (Claude, etc.) calls tools here; the tools send {@link BridgeRequest}s to the
 * connected studio via {@link callBridge} and return the results.
 *
 * SKELETON SCOPE (task NM-3): this file wires up the stdio transport, the tool
 * registry, and the single end-to-end-ish `connect_studio` tool. The
 * document / timeline / lighting / capture tools (NM-4, NM-5, NM-6) plug into
 * the registry via {@link registerTool} + {@link TOOL_MODULES} — see the
 * extension points below.
 *
 * MCP SDK: @modelcontextprotocol/sdk@1.29.0
 *   - { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
 *   - { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
 *   - server.registerTool(name, { title, description, inputSchema }, handler)
 *     where inputSchema is a Zod *raw shape* and the handler returns
 *     { content: [{ type: 'text', text }] }.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';

import { connectStudio, type StudioMode } from './studio.js';
import { documentTools } from './tools/document.js';
import { performTools } from './tools/perform.js';
import { timelineTools } from './tools/timeline.js';
import { backscreenTools } from './tools/backscreen.js';
import { feedbackTools } from './tools/feedback.js';
import { renderTools } from './tools/render.js';
import { escapeTools } from './tools/escape.js';
import { graphicsTools } from './tools/graphics.js';
import { montageTools } from './tools/montage.js';
import { musicTools } from './tools/music.js';
import { postTools } from './tools/post.js';
import { externalTools } from './tools/external.js';
import { registerResources } from './resources.js';

// ---------------------------------------------------------------------------
// Tool definition + registry (the extension point for NM-4/NM-5/NM-6).
// ---------------------------------------------------------------------------

/**
 * The MCP tool handler shape we return to the SDK. We keep it loose (`unknown`
 * args) at the registry boundary; each tool narrows via its own Zod
 * `inputSchema` at registration time.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * A self-describing tool definition. Tool modules export one (or an array) of
 * these and add them to {@link TOOL_MODULES}; {@link registerAllTools} feeds
 * each one to {@link registerTool}.
 *
 * `inputSchema` is a Zod *raw shape* (a plain object of Zod types), matching the
 * SDK's `registerTool` contract. The handler receives the parsed args typed by
 * that shape.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<ToolResult> | ToolResult;
}

/** Convenience builder so tool modules get inference without restating the shape. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/**
 * Register a single tool definition on the MCP server.
 *
 * @param server The MCP server instance.
 * @param def    The tool definition (name, schema, handler).
 */
export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  def: ToolDef<Shape>,
): void {
  server.registerTool(
    def.name,
    {
      title: def.title ?? def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    },
    // The SDK validates `args` against `inputSchema` before invoking us. The
    // handler is cast at this boundary: ToolDef keeps it precisely typed for
    // authors, while the SDK's generic ToolCallback is satisfied structurally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (args: z.objectOutputType<Shape, z.ZodTypeAny>) => def.handler(args)) as any,
  );
}

// ---------------------------------------------------------------------------
// connect_studio — the one tool this skeleton ships.
// ---------------------------------------------------------------------------

const connectStudioTool = defineTool({
  name: 'connect_studio',
  title: 'Connect to an avatar-live studio',
  description:
    'Connect the newsroom to an avatar-live studio. In "attended" mode it waits ' +
    'for a studio you have already opened (with ?bridge=9777) to register. In ' +
    '"headless" mode it launches a Playwright Chromium pointed at the studio URL. ' +
    'Returns once the studio is connected and ready to receive commands.',
  inputSchema: {
    mode: z.enum(['attended', 'headless']).describe('attended = wait for an open studio; headless = launch one'),
    studioUrl: z
      .string()
      .url()
      .optional()
      .describe('Studio URL for headless mode (default http://localhost:5175)'),
  },
  async handler({ mode, studioUrl }) {
    try {
      const session = await connectStudio({ mode: mode as StudioMode, studioUrl });
      const caps = session.capabilities.length ? session.capabilities.join(', ') : 'none reported';
      return {
        content: [
          {
            type: 'text',
            text:
              `Connected to studio "${session.studioId}" (${session.mode} mode). ` +
              `Capabilities: ${caps}. Ready to receive newsroom commands.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to connect studio: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

/**
 * The registry of tool modules. NM-4/NM-5/NM-6 add their tool definitions here
 * (import the module's exported `ToolDef[]` and spread it in). Everything in
 * this array is registered at startup by {@link registerAllTools}.
 *
 * EXTENSION POINT: e.g.
 *   import { documentTools } from './tools/document.js';
 *   import { timelineTools } from './tools/timeline.js';
 *   export const TOOL_MODULES = [connectStudioTool, ...documentTools, ...timelineTools];
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_MODULES: ToolDef<any>[] = [
  connectStudioTool,
  ...documentTools,
  ...performTools,
  ...timelineTools,
  ...backscreenTools,
  ...feedbackTools,
  ...renderTools,
  ...escapeTools,
  ...graphicsTools,
  ...montageTools,
  ...musicTools,
  ...postTools,
  ...externalTools,
];

/** Register every tool in {@link TOOL_MODULES} on the server. */
export function registerAllTools(server: McpServer): void {
  for (const def of TOOL_MODULES) {
    registerTool(server, def);
  }
}

// ---------------------------------------------------------------------------
// main — start the stdio MCP server.
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'newsroom-mcp',
    version: '0.0.0',
  });
  registerAllTools(server);
  registerResources(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log to stderr only.
  process.stderr.write(
    `[newsroom-mcp] stdio server ready. Tools: ${TOOL_MODULES.map((t) => t.name).join(', ')}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[newsroom-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
