import { BRIDGE_TOOLS, BRIDGE_PARAM_SCHEMAS } from '@las/protocol';
import type { McpToolResult, WebMcpTool } from './types.js';

/**
 * The studio side-effects each tool needs, injected so this builder stays pure and DOM-free
 * (testable in node). `server.ts` wires the real implementations; tests pass stubs.
 */
export interface StudioToolDeps {
  /** Run a bridge command and return its JSON-serializable result. */
  dispatch: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Capture a screenshot, returned inline (base64 PNG) — the see→verify primitive. */
  screenshot: (params: Record<string, unknown>) => Promise<{ data: string; mimeType: string; width: number; height: number }>;
  /** Render + download an MP4 in-browser; returns metadata (no inline blob — too large). */
  exportVideo: () => Promise<{ bytes: number; filename: string }>;
  /** Whether to register the `execute_js` escape hatch (off by default for safety). */
  allowExecuteJs: boolean;
}

function textResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function errorResult(err: unknown): McpToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

/**
 * Build the studio's WebMCP tools from the protocol manifest ({@link BRIDGE_TOOLS}). Every tool
 * routes back through the shared bridge dispatcher, EXCEPT `screenshot` and `export_mp4` which
 * use the in-page-specific deps (inline image / browser download) instead of the WS sink.
 *
 * `execute_js` is omitted unless `deps.allowExecuteJs` — a page exposing arbitrary eval to a
 * connected AI client is opt-in only (the §7 capability-scoping open question).
 */
export function buildStudioTools(deps: StudioToolDeps): WebMcpTool[] {
  const tools: WebMcpTool[] = [];
  for (const def of BRIDGE_TOOLS) {
    if (def.cmd === 'executeJs' && !deps.allowExecuteJs) continue;

    const execute = async (input: Record<string, unknown>): Promise<McpToolResult> => {
      try {
        // Validate input against the command's zod params BEFORE dispatching — the WS bridge
        // does this via parseBridgeRequest, and createDispatcher only coerces (String/Number),
        // never validates. Without this, set_voice{rate:10}, add_cue{start:-5}, or
        // set_backscreen_media{} would pass silently into the studio. zod throws → errorResult.
        const params = BRIDGE_PARAM_SCHEMAS[def.cmd].parse(input) as Record<string, unknown>;
        if (def.cmd === 'screenshot') {
          const shot = await deps.screenshot(params);
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
              { type: 'text', text: JSON.stringify({ width: shot.width, height: shot.height }) },
            ],
          };
        }
        if (def.cmd === 'exportMp4') {
          return textResult(await deps.exportVideo());
        }
        return textResult(await deps.dispatch(def.cmd, params));
      } catch (err) {
        return errorResult(err);
      }
    };

    tools.push({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: def.readOnly },
      execute,
    });
  }
  return tools;
}
