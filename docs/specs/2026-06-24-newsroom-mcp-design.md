# Newsroom MCP — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorm) → implementing Phase 1
**Scope:** An MCP server that lets an LLM fully drive the LiveAvatarStream3D avatar news studio to author and render news reports — a "Blender-MCP for the newsroom." All-inclusive: every knob (script/DSL, avatar, voice, emotion/gesture, camera, lighting, look, back-screen, timeline, render/export) is controllable, plus an `execute_js` escape hatch.

## 1. Goal & shape

The platform already has the "brain": the `NewsReportDoc` DSL and the `compileNewsReport` / `compileManifest` compilers in `@las/protocol`. What's missing is a stable control surface so an LLM can drive the studio end-to-end. Newsroom MCP is that surface.

Everything funnels through one canonical **`NewsReportDoc`** (the LLM authors/edits it) plus the existing compilers, so the live preview (browser) and the GPU master (engine-three) are the *same* performance — WYSIWYG holds across tiers.

Reference model: **Blender-MCP** — a socket into the live app, high-level tools, a code escape hatch (`execute_blender_code`), and a viewport screenshot feedback loop. Newsroom MCP mirrors this for a browser-based studio.

## 2. Architecture

```
LLM  ⇄  Newsroom MCP (services/newsroom-mcp, Node/TS, stdio)
            │  imports @las/protocol (NewsReportDoc + compilers) — no schema dup
            ├── Tier 1: Studio Bridge  ⇄  avatar-live (browser: preview + WebCodecs export)
            ├── Tier 2: Asset generators (node-canvas graphics · ffmpeg montage/post · Python music · external models)
            └── Tier 3: render_master  ⇄  control-api → compileManifest → engine-three (GPU master)
```

**Server:** `services/newsroom-mcp` — a stdio MCP server in TypeScript. TS specifically so it imports `@las/protocol` directly (schema + compilers). Single brain the LLM talks to.

### 2.1 Tier 1 — Studio Bridge (default; the Blender-MCP analog)

A browser page cannot host a WebSocket *server*, so the topology is inverted from Blender's addon:

- The **MCP server runs a WebSocket server** (default `ws://127.0.0.1:9777`) plus a small sibling **HTTP server** (for binary uploads — exported MP4s, screenshots).
- A **bridge module added to avatar-live** (`apps/avatar-live/src/bridge/`) connects to that WS as a **client** when enabled (via `?bridge=9777` query param or `VITE_BRIDGE` env; **off by default**). It registers, then executes commands and replies.
- **Command protocol** (JSON over WS): request `{ id, cmd, params }` → reply `{ id, ok, result }` or `{ id, ok:false, error }`. Each MCP tool maps to one (or a few) bridge commands.
- **Two run modes, one protocol:**
  - **Attended** — you open the studio in your browser with the bridge enabled; the LLM drives the session you're watching.
  - **Headless** — the MCP launches a headless Chromium (Playwright) pointed at the studio URL with the bridge param; it connects back automatically.
- **Binary results** (screenshots, exported MP4): the bridge uploads to the MCP's HTTP endpoint (`POST /upload/{kind}/{id}`); the MCP saves to a working dir and returns a path (and, for screenshots, an MCP image content block via base64). Avoids giant base64 frames over WS where possible.

### 2.2 Tier 2 — Asset generators (server-side tools)

The generators proven this session, promoted to first-class tools (run in the MCP process, not the browser):
- **graphics** — `node-canvas` broadcast cards (title/lower-third/data cards) from facts.
- **montage** — `ffmpeg` cards → a synced wall video (paired with the studio's `seekScreen` so it tracks narration in the export).
- **music** — parametric Python/numpy synth (mood/tempo/progression → WAV).
- **post** — `ffmpeg` post: intro card, music bed, lower-thirds, concat.
- **external** (auth-gated by the provider's own login): `generate_image` / `generate_audio` via Runway / Comfy / etc.

### 2.3 Tier 3 — Production GPU master

`render_master` submits the same `NewsReportDoc` through **control-api → compileManifest → engine-three** on the GPU pod, polling to completion → master URL. Reuses the existing pipeline; no duplicated logic.

## 3. Tool surface (all-inclusive)

**① Session & feedback:** `connect_studio` (attended | headless), `get_studio_state`, `screenshot` (viewport | output; optional `seek=t`).
**② Document core:** `set_newscast`, `patch_newscast`, `validate_newscast` (all via `@las/protocol`).
**③ Performance mutators:** `set_script`, `set_voice`, `set_avatar`, `set_emotion`, `set_lighting`, `set_look`, `set_capture_format`.
**④ Timeline/direction:** `add_cue`, `update_cue`, `remove_cue`, `list_cues`, `capture_view`, `set_timeline_length`, `clear_timeline`.
**⑤ Back-screen/set:** `set_headline`, `set_backscreen_media`, `generate_backscreen_cards`, `build_backscreen_montage`.
**⑥ Asset generators:** `generate_graphics`, `generate_music`, `post_produce`, `generate_image`, `generate_audio`.
**⑦ Render tiers:** `preview` (T1), `export_mp4` (T1), `render_master` (T3).
**⑧ Escape hatch + resources:** `execute_js` (arbitrary JS vs `window.__las` + DOM — unrestricted). MCP **resources** (read-only catalogs): avatars, voices, cue catalog (shots/moves/gestures), look + lighting presets, and the live `NewsReportDoc`.

**Design stance:** document-centric (`set_newscast`/`patch_newscast`) as the fast path; granular mutators for fine control; `screenshot` + `get_studio_state` as the feedback loop; `execute_js` for the 5% no tool covers.

## 4. Phasing

- **Phase 1 — Foundation + Tier-1 core loop.** Studio Bridge in avatar-live; MCP skeleton (stdio + WS/HTTP transport, attended + headless connect); core tools (①②③④, `set_headline`/`set_backscreen_media`, `preview`, `export_mp4`, `execute_js`) + catalog resources. Outcome: LLM connects → authors a doc → tweaks → screenshots → exports MP4.
- **Phase 2 — Asset generators + post (Tier 2).** `generate_graphics`, `generate_backscreen_cards`, `build_backscreen_montage`, `generate_music`, `post_produce`, external `generate_image`/`generate_audio`.
- **Phase 3 — Production GPU master (Tier 3).** `render_master` → control-api → engine-three, with polling.

Spec covers all three; the first implementation plan targets Phase 1 (where the value and the architectural risk — the bridge protocol — concentrate). Phases 2–3 mostly lift generators/pipeline already proven this session into tools.

## 5. Phase 1 implementation breakdown (BatonDeck)

Dependencies in parens.

1. **Bridge protocol contract** — `packages/protocol/src/bridge.ts`: zod/TS types for `BridgeCommand`/`BridgeResult` + the command enum + payload shapes. Exported from `@las/protocol`; imported by both sides. (foundation)
2. **Studio Bridge (avatar-live)** — `apps/avatar-live/src/bridge/{index.ts,dispatch.ts}`: WS client (reconnecting), `initBridge()` gated by `?bridge=`/env, a dispatcher mapping each command to existing controllers / `__las` / DOM / export, and the HTTP upload for screenshot/export blobs. Wire `initBridge()` in `main.ts`. (1)
3. **MCP server skeleton** — `services/newsroom-mcp/`: package.json (`@modelcontextprotocol/sdk`, `ws`, `playwright`), tsconfig, `src/server.ts` (stdio MCP), `src/transport.ts` (WS server + HTTP upload sink + request/response correlation by id), `connect_studio` (attended waits for a bridge to connect; headless launches Playwright → studio URL `?bridge=` → awaits connect). (1)
4. **Tools: document + mutators** — `src/tools/document.ts` (`set_newscast` via `compileNewsReport` then apply; `patch_newscast`; `validate_newscast`), `src/tools/perform.ts` (script/voice/avatar/emotion/lighting/look/format). (3)
5. **Tools: timeline + backscreen + feedback + render** — `src/tools/timeline.ts`, `src/tools/backscreen.ts`, `src/tools/feedback.ts` (`get_studio_state`, `screenshot`), `src/tools/render.ts` (`preview`, `export_mp4`), `src/tools/escape.ts` (`execute_js`). (3)
6. **Catalog resources** — `src/resources.ts`: avatars, voices, cue catalog, look/lighting presets, live doc — sourced from the bridge `get_studio_state` + `@las/protocol` enums. (3)

**Verification (no test runner in avatar-live):** `npm run typecheck` on protocol + avatar-live + newsroom-mcp; protocol vitest for `bridge.ts` shapes; an end-to-end smoke — start the MCP, `connect_studio` headless, `set_newscast` (the Fable/Mythos sample), `screenshot`, `export_mp4`, assert a valid MP4 — driven by a small script under `services/newsroom-mcp/scripts/smoke.ts`. No CI; validate locally.

## 6. Conventions & risks

- Bridge is **off by default** (no control surface unless explicitly enabled) — safe for normal studio use.
- `execute_js` is unrestricted by request; it only runs when the bridge is enabled and a client is connected.
- Reuse the existing controllers via the bridge dispatcher — do **not** duplicate studio logic in the MCP.
- Binary transfer via the sibling HTTP sink, not giant WS frames.
- Headless export needs Chromium with WebCodecs (Playwright's bundled Chromium supports it).
