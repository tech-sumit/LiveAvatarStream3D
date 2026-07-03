/**
 * Newsroom MCP — generated-asset resources.
 *
 * One read-only MCP resource that lists the assets this server has generated
 * and is serving over the local asset server (see `assets/serve.ts`). Clients
 * read it to rediscover a served URL / local path after the tool call that
 * produced it has scrolled away.
 *
 * The old catalog resources (emotions / gestures / cue types / presets) and the
 * live studio resources (state / avatars / voices) were studio-control surface;
 * they moved to the studio's in-browser WebMCP server — see
 * docs/specs/2026-06-25-webmcp-studio-control-design.md.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { listAssets, workDir } from './assets/serve.js';

/** Read-only JSON content helper for a resource handler. */
function jsonContents(uri: string, data: unknown): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Register the read-only newsroom resources on the MCP server. Called by
 * `createServer` in `server.ts`.
 */
export function registerResources(server: McpServer): void {
  // ── newsroom://assets/generated ───────────────────────────────────────────
  server.registerResource(
    'generated-assets',
    'newsroom://assets/generated',
    {
      title: 'Generated assets',
      description:
        'Every asset this server has generated and is serving (id, served URL, ' +
        'local path), plus the work dir they live in. Apply an asset in the ' +
        "studio by passing its URL to the studio's WebMCP tools " +
        '(e.g. set_backscreen_media).',
      mimeType: 'application/json',
    },
    (uri) =>
      jsonContents(uri.href, {
        workDir: workDir(),
        assets: listAssets(),
      }),
  );
}
