# Driving the studio from Claude Code (WebMCP integration)

**Date:** 2026-06-27 · **Status:** working, verified end-to-end · **Builds on:**
`2026-06-25-webmcp-studio-control-design.md` (the in-page WebMCP server). Two interchangeable
bridges: the official **`chrome-devtools-mcp`** (recommended) or **`@tech-sumit/mcp-webmcp`**
(sibling `projects/webmcp/`).

The studio registers its control tools on the page's **standard** `navigator.modelContext`
(WebMCP). This doc is the operational recipe for driving those tools **from Claude Code** (or
Cursor / Claude Desktop) — no studio code changes, no bridge of our own.

## How it fits together

```
Claude Code ──stdio MCP──▶ [WebMCP bridge] ──Puppeteer/Playwright/CDP──▶ Chrome (native WebMCP)
                                                                           └─ avatar-live tab
                                                                                navigator.modelContext
                                                                                = the 24 studio tools
```

- A **WebMCP bridge** is a normal MCP server that exposes two meta-tools — *list* and *execute*
  the WebMCP tools the active page registered — by reading the page's `navigator.modelContext`
  registry over CDP/Puppeteer. `chrome-devtools-mcp` calls them `list_webmcp_tools` /
  `execute_webmcp_tool`; `mcp-webmcp` calls them `webmcp_list_tools` / `webmcp_call_tool`.
- The studio is discoverable **out of the box**: it only calls
  `navigator.modelContext.registerTool(...)` (via `initWebMcp`). WebMCP is **native in Chrome**
  behind a feature flag — there is no polyfill to inject. `chrome-devtools-mcp` wants
  `--enable-features=WebMCP,DevToolsWebMCPSupport` (stable 149+); `mcp-webmcp` wants
  `--enable-features=WebMCPTesting` (Beta/Canary 146+). Either way the studio code is identical.

## Two bridges (pick one — they're interchangeable)

The studio registers on the **standard** `navigator.modelContext`, so it works with **either**
WebMCP bridge unchanged. Both read the same tool registry; they differ in the Chrome they want
and the extra tooling they bring.

| Bridge | Chrome | Adds | Use when |
|---|---|---|---|
| **`chrome-devtools-mcp`** (official, Google) | **stable Chrome 149+** | Full DevTools: native `take_screenshot`, performance traces, network, console | **Recommended** — official, works with your system Chrome 149, no chrome-beta |
| **`@tech-sumit/mcp-webmcp`** | Chrome Beta/Canary 146+ | 24 Playwright browser tools | You're on chrome-beta, or already have it wired |

> **Verified (2026-06-27):** plain **system Chrome 149.0.7827.201** launched with
> `--enable-features=WebMCP,DevToolsWebMCPSupport,WebMCPTesting` exposes `navigator.modelContext`
> and the studio registered **all 24 tools** there (checked over CDP). No chrome-beta needed.

## Prerequisites

| Need | Detail |
|---|---|
| **A WebMCP-capable Chrome** | stable **149+** for `chrome-devtools-mcp`; **Beta/Canary 146+** for `mcp-webmcp`. |
| **The studio served** | `npm run dev:avatar` → http://localhost:5175 (or a deployed build). |
| **A bridge registered** in your MCP client | This repo's `.mcp.json` ships both. |

## Option A (recommended): official `chrome-devtools-mcp`

`.mcp.json` entry (shipped in this repo):

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y", "chrome-devtools-mcp@latest",
        "--category-experimental-webmcp",
        "--chrome-arg=--enable-features=WebMCP,DevToolsWebMCPSupport"
      ]
    }
  }
}
```

- `--category-experimental-webmcp` turns on the `list_webmcp_tools` / `execute_webmcp_tool`
  tools. `--chrome-arg=--enable-features=WebMCP,DevToolsWebMCPSupport` passes the WebMCP feature
  flags to the Chrome it launches (stable 149+).
- To drive your **already-running** Chrome instead of launching one, add
  `--browser-url=http://127.0.0.1:9222` (start that Chrome yourself with
  `--remote-debugging-port=9222 --enable-features=WebMCP,DevToolsWebMCPSupport`), or
  `--auto-connect` (Chrome 144+, after enabling remote debugging at
  `chrome://inspect/#remote-debugging`).

Drive loop:
1. `new_page` / `navigate_page` → `http://localhost:5175/?webmcp=full`
2. `list_webmcp_tools` → the studio's 24 tools.
3. `execute_webmcp_tool` `{ "toolName": "set_headline", "input": "{\"text\":\"…\"}" }`
   (`input` is **JSON-stringified** params). Returns `{status, output, errorText}`.
4. For verification, prefer the **native `take_screenshot`** (full-res, CDP) over the studio's
   own `screenshot` tool — no thumbnail compromise needed (see Gotchas).

## Option B: `@tech-sumit/mcp-webmcp`

`.mcp.json` entry (also shipped):

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

### Option B drive loop

1. **`browser_launch`** `{ "channel": "chrome-beta", "url": "http://localhost:5175/?webmcp=full" }`
   — opens Chrome Beta with WebMCP enabled and loads the studio.
2. **`webmcp_list_tools`** — discovers the studio's tools and their JSON-Schemas.
3. **`webmcp_call_tool`** `{ "name": "<tool>", "arguments": { … } }`.

(The tool names + which page params apply are identical for both bridges — only the meta-tool
wrappers differ: Option A uses `list_webmcp_tools` / `execute_webmcp_tool` with a
JSON-stringified `input`; Option B uses `webmcp_list_tools` / `webmcp_call_tool` with an
`arguments` object.)

## The studio tool surface

Both bridges expose the same 24 tools. A natural sequence:

- `apply_newscast` `{doc}` (a Score or NewsReportDoc) — or `set_script` / `set_voice` /
  `set_avatar` / `set_emotion` / `set_lighting` / `set_look` / `set_headline`.
- **see → verify**: native `take_screenshot` (Option A) or the studio's `screenshot`
  `{target:"viewport"}` (Option B), then adjust and repeat.
- `export_mp4` to render — it downloads the MP4 in-browser and returns `{bytes, filename}`.

`?webmcp=full` (on the studio URL) additionally registers the `execute_js` escape hatch; omit
it for the safe default set; `?webmcp=off` disables the in-page server entirely. The full tool
list + schemas live in `packages/protocol/src/bridgeTools.ts` (`BRIDGE_TOOLS`) and are
summarized in the §4 table of `2026-06-25-webmcp-studio-control-design.md`.

## Gotchas (learned wiring this up)

- **The studio's own `screenshot` tool returns a 720px JPEG thumbnail, not full-res.** A bridge
  surfaces a WebMCP tool result as a **JSON-stringified text** blob, so a full-resolution PNG
  (~3.4 MB base64) overruns the MCP client's per-result token budget. The studio therefore
  downscales its WebMCP screenshot to a compact JPEG (`apps/avatar-live/src/mcp/server.ts`
  `downscaleToJpeg`). **With Option A you don't hit this** — use the native `take_screenshot`
  (CDP, full-res, returned as a proper image), and the studio's thumbnail tool is just a fallback.
- **`export_mp4` downloads to disk**; it does not return the video bytes (50 MB+ is impractical
  inline). Move the file into `apps/avatar-live/public/generated/` per that folder's convention.
- **`execute_js` is opt-in** — only registered with `?webmcp=full`.
- The realtime preview rAF loop pauses in a backgrounded tab, but **export still renders**
  frame-by-frame, so `export_mp4` works even when the launched Chrome window isn't focused.

## Verified (2026-06-27)

- **Option B, live:** through this repo's `mcp-webmcp` (`--channel chrome-beta`) on Chrome Beta
  150 — `browser_launch` → `webmcp_list_tools` returned all **24** studio tools with correct
  JSON-Schemas; `webmcp_call_tool set_headline` + `set_emotion` then `get_state` round-tripped
  the mutations; `screenshot` returned a viewable 720×405 JPEG image block.
- **Option A premise, over CDP:** plain **system Chrome 149.0.7827.201** launched with
  `--enable-features=WebMCP,DevToolsWebMCPSupport,WebMCPTesting` + the studio at `?webmcp=full`
  exposed `navigator.modelContext` (`registerTool` present) and the studio had registered all
  **24** tools — confirming `chrome-devtools-mcp` (which reads the same registry via Puppeteer's
  `page.webmcp`) will drive them on stable Chrome 149, no chrome-beta needed.
