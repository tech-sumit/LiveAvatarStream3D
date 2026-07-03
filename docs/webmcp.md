# Driving the studio with an AI agent (WebMCP)

The studio is **agent-native**: on load it registers its controls as [WebMCP](https://github.com/webmachinelearning/webmcp) tools on the page's model-context registry (`document.modelContext`, with a fallback to the older `navigator.modelContext`). Any WebMCP-capable AI client attached to the tab can then author scripts, direct cameras and lighting, and export the MP4 — no extension-specific glue, no server.

This works on the **hosted demo** ([las3d-studio.pages.dev](https://las3d-studio.pages.dev/)) exactly as it does on a local `npm run dev:avatar`.

## Connect an agent

**Requirements:** a WebMCP-capable Chromium (Chrome 146+ / current Chrome Beta with the WebMCP Early Preview).

### A. Chrome's built-in / in-browser agents
Open the studio in a WebMCP-capable Chrome. The 23 studio tools are simply *there* — an in-browser assistant that speaks WebMCP discovers them on the page and can call them directly. Nothing to configure.

### B. Claude Code / Claude Desktop / any stdio MCP client
Bridge the tab to a desktop client with [`@tech-sumit/mcp-webmcp`](https://www.npmjs.com/package/@tech-sumit/mcp-webmcp) (this repo's `.mcp.json` already ships this entry):

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

Then, from the agent: `browser_launch` (or attach) → `browser_navigate` to the studio URL → `webmcp_list_tools` → `webmcp_call_tool`. Every demo video in the README was produced through this exact path by Claude Code.

### C. Scripted / CI control
[`@tech-sumit/webmcp-cdp`](https://github.com/tech-sumit) drives WebMCP tools over the Chrome DevTools Protocol — "Playwright for WebMCP" — when you want deterministic scripts rather than an LLM.

## The tool surface (23 tools)

| Group | Tools |
|---|---|
| **Performance authoring** | `set_script` (inline `[emotion][gesture]` tags) · `apply_newscast` (full Score / NewsReportDoc — validated + compiled) · `patch_newscast` · `validate_newscast` |
| **Stage & look** | `set_avatar` · `set_emotion` · `set_voice` · `set_headline` · `set_backscreen_media` · `set_lighting` · `set_look` |
| **Timeline** | `add_cue` · `update_cue` · `remove_cue` · `list_cues` · `clear_timeline` · `set_timeline_length` · `capture_view` |
| **See → verify** | `get_state` (full studio snapshot incl. avatar/voice catalogs) · `screenshot` (downscaled JPEG; `target: "output"` renders on demand even in a hidden tab) |
| **Produce** | `preview` (live playback) · `set_capture_format` (720p/1080p/4k/vertical/square, avc/hevc) · `export_mp4` (frame-exact in-browser render → file download; returns `{bytes, filename}`) |

Schemas come from the shared zod contracts in [`packages/protocol`](../packages/protocol) — `webmcp_list_tools` (or any WebMCP client) returns the full JSON Schema per tool.

## Recipe: an agent creates a video, hands-free

```text
1. get_state                 → discover avatars, voices, current script
2. apply_newscast {doc}      → load a full performance (or set_script for a quick one)
3. set_lighting / set_look   → art-direct the stage (optional)
4. screenshot {target:"output", seek:5}  → verify a frame before spending render time
5. set_capture_format {resolution:"1080p"}
6. export_mp4                → renders frame-by-frame in the tab, downloads the MP4
```

Narration audio for the export needs ElevenLabs: locally, set `ELEVENLABS_API_KEY` in `apps/avatar-live/.env`; on the hosted demo, paste your key in the **Voice** panel (it is stored in that browser's localStorage only and sent only to the ElevenLabs API). Without a key you still get the live Web Speech preview — browser speech audio cannot be captured into an export.

Camera direction is data: `apply_newscast` beats accept `"camera": { "preset": "hero-low" }` from the [10-shot catalog](../packages/performer-core/src/cameraShots.ts), and the timeline `add_cue` camera track accepts the same framings.

## Switches & security

- `?webmcp=off` (or `VITE_WEBMCP=off` at build time) disables registration entirely.
- `?webmcp=full` additionally registers an `execute_js` escape hatch — full page access for the attached agent. It is **off by default**; don't make it your normal launch URL.
- Registering tools means *any* AI client attached to the tab can mutate studio state and trigger a file download (that is the WebMCP model). The single-user studio accepts this; a multi-user deployment should add a per-session opt-in before registering. See the design spec: [`docs/specs/2026-06-25-webmcp-studio-control-design.md`](specs/2026-06-25-webmcp-studio-control-design.md).
