# In-browser WebMCP control for the studio — design / task

**Status:** **v1 implemented** (2026-06-27) · **Date:** 2026-06-25 · **Depends on / complements:**
the Performance Score DSL design (`2026-06-25-performance-score-dsl-design.md`). This is
**additional** to the scripting spec: the Score/Stage is the *authored artifact*; this is the
*live control channel* an AI app uses to drive the studio.

> **v1 landed.** The §4 tool surface is live: `@las/protocol` exports a `BRIDGE_TOOLS` manifest
> (one entry per `BridgeCommand`, JSON-Schema generated from the same zod params), and
> `apps/avatar-live/src/mcp/` registers them on `navigator.modelContext` via `initWebMcp`
> (wired in `main.ts`). It reuses the existing `bridge/dispatch.ts` handlers verbatim, so the
> MCP tool surface and the WS bridge can never diverge. No-op when the runtime lacks
> `navigator.modelContext` (normal browsers) or `?webmcp=off`. The **v2** parameterized
> authoring/direction tools (`load_stage`/`load_score`/`frame(subjects)`/…) remain to be added
> as the Score/Stage surfacing lands. See "Open questions" for the v1 resolutions.

## 1. Goal

The avatar-live browser studio should expose its **own MCP server inside the page** using the
**WebMCP** specification, so that **any AI app** (Claude, an agent, a custom client) can connect
**directly to the browser tab** and control the studio — load/author a Score, set voice/avatar,
tweak lighting/look, drive the camera, render/export, take a screenshot, iterate — with **no
separate stdio MCP process and no WebSocket bridge**.

Today this is done out-of-process: `services/newsroom-mcp` is a stdio MCP that talks to the
studio over the `@las/protocol` bridge WebSocket (`bridge.ts`). WebMCP collapses that into the
page itself: the studio *is* the MCP server; the AI client attaches to the tab.

## 2. Why WebMCP (vs the current stdio-MCP + bridge)

- **One process.** The tools run in the page, against the live studio state — no bridge relay,
  no `studioId` registration, no "is a studio connected?" failure mode.
- **Any client.** WebMCP is the open contract; any MCP-capable AI app that speaks the browser
  side (extension / `navigator.modelContext`) can drive the studio. Reuses the user's existing
  webmcp work (`projects/webmcp`, the `mcp-webmcp` bridge).
- **Live + agentic.** The AI sees real studio state and the rendered viewport (screenshot tool),
  closing the see→act→verify loop locally — exactly the loop this whole session needed.

## 3. Architecture

```
  Any AI app  ──(WebMCP: extension / navigator.modelContext)──▶  avatar-live tab
                                                                  │
                                            ┌─────────────────────┴───────────────┐
                                            │  StudioMcpServer (new, in-page)      │
                                            │  registerTool(name, schema, handler) │
                                            └─────────────────────┬───────────────┘
                                                                  │ reuses
                                            ┌─────────────────────▼───────────────┐
                                            │  existing bridge dispatch handlers   │
                                            │  (src/bridge/dispatch.ts) + studio    │
                                            └──────────────────────────────────────┘
```

- **New module** `apps/avatar-live/src/mcp/server.ts`: a `StudioMcpServer` that, on load,
  registers the studio's tools with the WebMCP runtime (the page-side registration API per the
  WebMCP spec — `navigator.modelContext.registerTool(...)` or the project's WebMCP shim).
- **Reuse, don't reinvent, the tool surface.** The handlers already exist in
  `src/bridge/dispatch.ts` (driven by `@las/protocol`'s `BridgeCommand`). The WebMCP server is a
  thin adapter: each MCP tool's handler calls the same dispatch logic. The bridge command
  vocabulary becomes the MCP tool vocabulary — defined **once** in `@las/protocol`.
- **Schemas from the protocol.** Tool input schemas come from the existing zod schemas
  (`bridge.ts`, the new `Score`/`Stage` schemas) → JSON Schema, so tools self-describe.

## 4. Tool surface (v1 = today's bridge, parameterized later)

Derived from `@las/protocol` `bridge.ts` (the contract already exists):

| Tool | Backed by | Notes |
|---|---|---|
| `get_state` | `getState` | current avatar/voice/look/timeline/script |
| `screenshot` | `screenshot` (viewport/output) | the see→verify primitive |
| `set_script` / `set_voice` / `set_avatar` / `set_emotion` | the matching bridge cmds | |
| `set_lighting` / `set_look` | preset or explicit params | |
| `add_cue` / `update_cue` / `remove_cue` / `list_cues` | timeline cues | |
| `apply_newscast` / `patch_newscast` / `validate_newscast` | `NewsReportDoc` | until the Score replaces it |
| `capture_view` | save the current camera as a reusable shot | feeds Stage `savedShots` |
| `set_capture_format` / `export_mp4` / `preview` | render/export | export runs in-browser |
| `execute_js` | escape hatch | parity with the bridge |

**v2 (after the Score/Stage spec lands):** `load_stage`, `load_score`, `perform_score`,
`edit_beat`, `add_mark`, `frame(subjects)` — the parameterized authoring/direction tools. The
AI then authors and drives a performance entirely through these, no code edits (the §11 goal of
the scripting spec, now agent-operable).

## 5. Relationship to the scripting spec

- **Scripting spec** = the *data model* (Stage + Score + the interpreter) — what a performance
  *is*, authored by a human or an LLM.
- **This spec** = the *live API* — how an AI app *operates* the studio in real time: load a
  Score, render, screenshot, adjust, re-render. They compose: the AI writes a Score (scripting
  spec) and drives it via WebMCP (this spec).

## 6. Migration

1. Land the `StudioMcpServer` registering today's bridge tools (v1) — immediately lets any AI
   app drive the current studio in-browser.
2. As the Score/Stage model lands, add the v2 authoring/direction tools.
3. Deprecate `services/newsroom-mcp` (stdio + bridge) in favor of the in-page server; keep a thin
   headless shim only if a non-browser client is needed.

   > **Status (2026-07-03, round 4):** DONE — the WS bridge transport + all studio-control
   > tools were removed from `services/newsroom-mcp` (now a pure asset-generation MCP) and the
   > studio's WS client (`bridge/index.ts`, the 9778 sink, `VITE_BRIDGE`/`?bridge=`) was deleted.
   > WebMCP is the only studio-control surface.

## 7. Open questions — v1 resolutions

- **Registration surface** → target `navigator.modelContext` directly (the W3C WebMCP page API,
  Chrome 146+ / the shape `projects/webmcp/library` augments). No React dependency: avatar-live
  declares a minimal local type surface (`src/mcp/types.ts`) and feature-detects the API, so the
  studio is a plain no-op in browsers without WebMCP.
- **Capability scoping for `execute_js`** → **opt-in only.** The eval escape hatch is *not*
  registered by default; it requires `?webmcp=full` (or `VITE_WEBMCP=full`). All other tools
  register whenever the API is present. (A richer per-tool consent model is still future work.)
- **`screenshot` return** → returned **inline** as an MCP `image` content block, so the AI closes
  the see→verify loop locally with no HTTP sink. It is a **downscaled JPEG thumbnail** (~720px),
  not a full-res PNG: a bridge like `mcp-webmcp` JSON-stringifies the tool result, and a full PNG
  (~3.4 MB base64) overruns the client's per-result token budget. See the Claude Code integration
  doc (`2026-06-27-webmcp-claude-code-integration.md`).
- **`export_mp4` return** → v1 renders in-browser and **triggers a browser download**, returning
  `{ bytes, filename }` metadata (a 50 MB+ base64 payload inline is impractical, and the in-page
  server has no sink). **R2 persistence + returning a URL remains the v2 option.**

### Still open (v2)

- A per-tool consent / permission prompt for a page exposing MCP tools to an external client.
- `export_mp4` → R2 persistence returning a signed URL instead of a local download.
- The v2 parameterized authoring/direction tools once the Score/Stage authoring surface lands.
```
