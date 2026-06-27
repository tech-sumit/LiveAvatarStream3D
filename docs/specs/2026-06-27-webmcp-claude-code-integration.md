# Driving the studio from Claude Code (WebMCP integration)

**Date:** 2026-06-27 · **Status:** working, verified end-to-end · **Builds on:**
`2026-06-25-webmcp-studio-control-design.md` (the in-page WebMCP server) and the
`@tech-sumit/mcp-webmcp` + `@tech-sumit/webmcp-cdp` bridge (sibling `projects/webmcp/`).

The studio registers its control tools on the page's `navigator.modelContext` (WebMCP). This
doc is the operational recipe for driving those tools **from Claude Code** (or Cursor / Claude
Desktop) — no studio code changes, no bridge of our own.

## How it fits together

```
Claude Code ──stdio MCP──▶ mcp-webmcp ──Playwright/CDP──▶ Chrome Beta 146+ (native WebMCP)
                                                              └─ avatar-live tab
                                                                   navigator.modelContext
                                                                   = the 24 studio tools
```

- **`mcp-webmcp`** is a normal MCP server. It exposes 24 Playwright browser tools plus two
  meta-tools — `webmcp_list_tools` and `webmcp_call_tool` — which call
  `navigator.modelContextTesting.listTools()` / `executeTool()` on the **active page**.
- The studio is discoverable **out of the box**: it only needs to call
  `navigator.modelContext.registerTool(...)` (it does, via `initWebMcp`). WebMCP is **native in
  Chrome 146+** behind `--enable-features=WebMCPTesting` — there is no polyfill to inject. The
  bridge reads the registered tools over CDP.

## Prerequisites

| Need | Detail |
|---|---|
| **Chrome Beta or Canary ≥ 146** | Stable Chrome won't expose WebMCP yet. `mcp-webmcp --launch` adds `--enable-features=WebMCPTesting` automatically. |
| **The studio served** | `npm run dev:avatar` → http://localhost:5175 (or a deployed build). |
| **`mcp-webmcp` registered** in your MCP client | See below. |

## Setup

This repo ships an `.mcp.json` entry, so opening the project in Claude Code wires it up:

```jsonc
{
  "mcpServers": {
    "mcp-webmcp": {
      "command": "npx",
      "args": ["-y", "@tech-sumit/mcp-webmcp", "--channel", "chrome-beta"]
    }
  }
}
```

(Equivalently, register it once globally: `npx -y @tech-sumit/mcp-webmcp config claude`.) Add
`"--launch"` to the args if you want Chrome to open automatically on server start instead of the
agent calling `browser_launch`.

## The drive loop

1. **`browser_launch`** `{ "channel": "chrome-beta", "url": "http://localhost:5175/?webmcp=full" }`
   — opens Chrome Beta with WebMCP enabled and loads the studio.
   - `?webmcp=full` additionally registers the `execute_js` escape hatch. Omit it for the safe
     default tool set (everything except `execute_js`).
   - `?webmcp=off` disables the in-page server entirely.
2. **`webmcp_list_tools`** — discovers the studio's tools and their JSON-Schemas (the
   `BRIDGE_TOOLS` manifest from `@las/protocol`). Always list before calling; WebMCP tools are
   page-scoped and change on navigation.
3. **`webmcp_call_tool`** `{ "name": "<tool>", "arguments": { … } }` — drives the studio. A
   natural sequence:
   - `apply_newscast` `{doc}` (a Score or NewsReportDoc) — or `set_script` / `set_voice` /
     `set_avatar` / `set_emotion` / `set_lighting` / `set_look` / `set_headline`.
   - `screenshot` `{target:"viewport"}` to **see** the result, adjust, repeat.
   - `export_mp4` to render — it downloads the MP4 in-browser and returns `{bytes, filename}`.

The full tool list + schemas live in `packages/protocol/src/bridgeTools.ts` (`BRIDGE_TOOLS`) and
are summarized in the §4 table of `2026-06-25-webmcp-studio-control-design.md`.

## Gotchas (learned wiring this up)

- **`screenshot` returns a 720px JPEG thumbnail, not full-res.** `mcp-webmcp` surfaces a WebMCP
  tool's result as a **JSON-stringified text** blob, so a full-resolution PNG (~3.4 MB base64)
  overruns the MCP client's per-result token budget. The studio therefore downscales the
  WebMCP screenshot to a compact JPEG (`apps/avatar-live/src/mcp/server.ts` `downscaleToJpeg`) —
  plenty to *verify* framing/pose/headline. The WS-bridge screenshot path is unaffected
  (still full-res PNG to its sink).
- **`export_mp4` downloads to disk**; it does not return the video bytes (50 MB+ is impractical
  inline). Move the file into `apps/avatar-live/public/generated/` per that folder's convention.
- **`execute_js` is opt-in** — only registered with `?webmcp=full`.
- The realtime preview rAF loop pauses in a backgrounded tab, but **export still renders**
  frame-by-frame, so `export_mp4` works even when the launched Chrome window isn't focused.

## Verified

2026-06-27, through this repo's `mcp-webmcp` (`@tech-sumit/mcp-webmcp --channel chrome-beta`) on
Chrome Beta 150: `browser_launch` → `webmcp_list_tools` returned all **24** studio tools with
correct JSON-Schemas; `webmcp_call_tool set_headline` + `set_emotion` then `get_state`
round-tripped the mutations; `screenshot` returned a viewable 720×405 JPEG image block.
