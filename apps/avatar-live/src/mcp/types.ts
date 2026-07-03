// Minimal local type surface for the W3C WebMCP page API (`navigator.modelContext`).
//
// We intentionally do NOT depend on the `react-webmcp` library here — avatar-live is vanilla
// TS, and we only need the page-registration shape. These mirror the spec's
// `ToolRegistrationParams` (Chrome 146+ / WebMCP Early Preview) plus the MCP `image` content
// block the studio's screenshot tool returns.

/** A block in a tool's result `content` array. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** What a tool's `execute` resolves to. */
export interface McpToolResult {
  content: McpContent[];
  /** Optional error flag (MCP `isError`). */
  isError?: boolean;
}

/** A tool registered with `navigator.modelContext`. */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;
}

/** The subset of `navigator.modelContext` we use. */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool): void;
  unregisterTool?(name: string): void;
}

/**
 * Read the page's WebMCP registry. The spec surface moved: `document.modelContext` is
 * current (Chrome logs a deprecation warning for the original `navigator.modelContext`),
 * so prefer it and fall back to navigator for older WebMCP builds. Null when the
 * runtime ships neither (normal browsers — the studio then skips registration).
 */
export function getModelContext(): { mc: ModelContextLike; surface: 'document' | 'navigator' } | null {
  const g = globalThis as {
    document?: { modelContext?: ModelContextLike };
    navigator?: { modelContext?: ModelContextLike };
  };
  if (g.document?.modelContext) return { mc: g.document.modelContext, surface: 'document' };
  if (g.navigator?.modelContext) return { mc: g.navigator.modelContext, surface: 'navigator' };
  return null;
}
