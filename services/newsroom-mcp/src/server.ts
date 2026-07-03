#!/usr/bin/env node
/**
 * Newsroom MCP server (stdio) — asset generation only.
 *
 * A Model Context Protocol server exposing the newsroom's ASSET-GENERATION
 * tools: broadcast graphics (node-canvas), back-screen montages + post
 * production (ffmpeg), a parametric music bed (python3 + numpy), and external
 * provider media (Runway image / ElevenLabs audio). Generated files land in a
 * work dir and are served read-only at http://127.0.0.1:9778/asset/<id> so the
 * browser studio can load them.
 *
 * This server does NOT control the studio. The old Studio Bridge surface (the
 * WS transport on 9777, connect_studio, set_* / cue / screenshot / export
 * tools) was superseded by the studio's own in-browser WebMCP server — see
 * docs/specs/2026-06-25-webmcp-studio-control-design.md. To apply a generated
 * asset, take the `url` from a tool result and call the studio's WebMCP tools
 * (e.g. `set_backscreen_media`) from your MCP client.
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

import { startAssetServer, ASSET_HTTP_PORT } from './assets/serve.js';
import { graphicsTools } from './tools/graphics.js';
import { montageTools } from './tools/montage.js';
import { musicTools } from './tools/music.js';
import { postTools } from './tools/post.js';
import { externalTools } from './tools/external.js';
import { registerResources } from './resources.js';

// ---------------------------------------------------------------------------
// Tool definition + registry.
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
 * A self-describing tool definition. Tool modules export an array of these and
 * add them to {@link TOOL_MODULES}; {@link registerAllTools} feeds each one to
 * {@link registerTool}.
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

/**
 * The registry of tool modules — asset-generation tools only. Everything in
 * this array is registered at startup by {@link registerAllTools}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_MODULES: ToolDef<any>[] = [
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
// main — start the stdio MCP server + the local asset server.
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
  // The asset server is this service's delivery mechanism — generated files
  // are only useful to the browser studio via their served URLs, so bring it
  // up before accepting tool calls. A bind failure (port in use) is fatal and
  // surfaces loudly, per project policy.
  await startAssetServer();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log to stderr only.
  process.stderr.write(
    `[newsroom-mcp] stdio server ready (assets on http://127.0.0.1:${ASSET_HTTP_PORT}/asset/…). ` +
      `Tools: ${TOOL_MODULES.map((t) => t.name).join(', ')}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[newsroom-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
