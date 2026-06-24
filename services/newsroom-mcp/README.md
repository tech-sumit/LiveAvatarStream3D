# @las/newsroom-mcp

A stdio **Model Context Protocol** server that drives an [avatar-live](../../apps/avatar-live)
studio — the browser app that owns the live Three.js newsroom scene — over the
**Studio Bridge** WS protocol defined in `@las/protocol`'s `bridge.ts`.

An MCP client (Claude Desktop, Claude Code, etc.) calls the tools exposed here.
Each tool sends a `BridgeRequest` to the connected studio and awaits the matching
`BridgeResult`, correlated by id.

## What this skeleton ships

- The stdio MCP server (`src/server.ts`) with a tool **registry** and one tool:
  - `connect_studio` — attach to an avatar-live studio (attended or headless).
- The transport layer (`src/transport.ts`): the WS bridge + HTTP upload servers
  and the `callBridge()` helper the (future) tool modules use.
- The studio connector (`src/studio.ts`): attended vs. headless connection.

The document / timeline / lighting / capture / export tools are **not** here —
they plug into `TOOL_MODULES` in `src/server.ts` (see Extending below) and are
owned by separate tasks (NM-4, NM-5, NM-6).

## Ports

| Port | Server | Purpose |
|------|--------|---------|
| `127.0.0.1:9777` | WebSocket | The avatar-live studio bridge connects here and performs the `register` handshake. Commands flow studio-ward; results flow back. |
| `127.0.0.1:9778` | HTTP | `POST /upload/<kind>/<id>` writes the request body to `<tmpdir>/newsroom-mcp/<id>.<ext>`. Use `uploadedPath(ref)` to resolve it. |

Both bind to loopback only.

## Build & run

```bash
# from the repo root
npm install
npm run build --workspace @las/newsroom-mcp     # tsc → dist/
npm run typecheck --workspace @las/newsroom-mcp  # tsc --noEmit

# run the server directly (stdio)
node services/newsroom-mcp/dist/server.js
# or
npm run start --workspace @las/newsroom-mcp
```

The server speaks MCP over **stdio**, so it is normally launched by an MCP
client rather than run by hand. Example client config:

```json
{
  "mcpServers": {
    "newsroom": {
      "command": "node",
      "args": ["services/newsroom-mcp/dist/server.js"]
    }
  }
}
```

`dist/server.js` is also exposed as the `newsroom-mcp` bin.

## Attended vs. headless

`connect_studio` takes a `mode`:

- **attended** — You have already opened the avatar-live studio in a real browser
  tab with the bridge enabled, e.g. `http://localhost:5175/?bridge=9777`. The
  tool ensures the bridge server is up and waits for that tab to register. Use
  this when you want to watch the studio drive live.

- **headless** — No tab is open. The tool launches a Playwright Chromium,
  navigates it to `studioUrl + '?bridge=9777'` (default
  `http://localhost:5175`), and waits for it to register. The browser is held
  open for the session and torn down on disconnect. Use this for automated runs.

## Resources (read-only)

`src/resources.ts` registers read-only MCP **resources** (addressed by
`newsroom://…` URIs, always `application/json`). The orchestrator calls
`registerResources(server)` inside `createServer`. They split into two groups:

**Static catalog** (sourced from `@las/protocol` enums — the vocabulary the
director/editor can use):

| URI | Contents |
|-----|----------|
| `newsroom://catalog/cues` | Camera shots & moves, plus the studio cue keys: camera (`cam.*`) and motion/gesture (`motion.*`). |
| `newsroom://catalog/emotions` | The enumerated `EMOTIONS`. |
| `newsroom://catalog/gestures` | The enumerated `GESTURES` (+ postures). |
| `newsroom://catalog/presets` | Look presets (broadcast/flat/cinematic/warm/noir), lighting presets (studio/soft/dramatic/warm/cool), capture resolutions & codecs. |

**Live studio** (round-trip `getState` over the bridge; degrade gracefully to a
JSON note when no studio is connected):

| URI | Contents |
|-----|----------|
| `newsroom://studio/state` | The full live `getState` payload. |
| `newsroom://studio/avatars` | Avatars the connected studio knows about. |
| `newsroom://studio/voices` | Voices the connected studio knows about. |

> The `cam.*` / `motion.*` cue keys are inlined in `resources.ts` (mirrored from
> `apps/avatar-live/src/timeline/catalog.ts`) so this Node service does not have
> to import browser code (which pulls in `three`). Keep them in sync if that
> catalog grows.

## End-to-end smoke test

`src/scripts/smoke.ts` exercises the whole path **without** the MCP stdio layer:
start the transport → connect a **headless** studio (Playwright Chromium →
avatar-live with `?bridge`) → apply a small Fable/Mythos `NewsReportDoc` →
screenshot the output → `exportMp4` → `ffprobe` the uploaded mp4 → print
**PASS/FAIL**.

```bash
# 1) start the avatar-live dev server (separate terminal), must be reachable at :5175
npm run dev:avatar          # → http://localhost:5175  (the MCP loads it headless with ?bridge)

# 2) build + run the smoke
npm run build --workspace @las/newsroom-mcp
npm run smoke --workspace @las/newsroom-mcp
```

It **degrades gracefully**: if Playwright/Chromium, the studio on `:5175`, or
`ffprobe` (ffmpeg) is unavailable, it prints `SMOKE skipped: <reason>` and exits
`0`. It exits non-zero only on a real **FAIL** (the pipeline ran but produced a
bad/empty mp4). Overrides: `SMOKE_STUDIO_URL`, `SMOKE_CONNECT_TIMEOUT_MS`.

Playwright Chromium must be installed for the headless path
(`npx playwright install chromium`); ffmpeg provides `ffprobe`.

## render_master (Tier 3 — production GPU master)

`src/tools/master.ts` adds **`render_master`**, the Phase-3 tool that hands the
newscast to the **production GPU pipeline** (not the browser) and returns a
finished MP4 master in R2.

Tier comparison:

| Tool | Where it renders | Output |
|---|---|---|
| `export_mp4` (Tier 1, `render.ts`) | the studio's **browser canvas**, locally | a local `.mp4` path |
| `render_master` (Tier 3, `master.ts`) | the **control-api → engine-three GPU pod** | an **R2 master** (download URL) |

What it does:

1. Resolves the newscast: a `NewsReportDoc` passed as `doc`, or — when omitted —
   the **studio's live doc** read over the bridge (`executeJs` to grab the
   in-memory `__las` newscast, falling back to `getState` scalars).
2. Lowers it into a DSL `Script` + assembles an `EngineRenderSpec`, validated
   against `@las/protocol`'s `CreateEngineRenderJobRequest`. The
   PerformanceManifest is **not** compiled here — the orchestrator does that
   server-side (`compileManifest`); we only assemble the job spec.
3. `POST {CONTROL_API_URL}/api/engine-jobs` `{ userId, spec }`, then **polls**
   `GET {CONTROL_API_URL}/api/jobs/{id}` until `succeeded` / `failed`.
4. Returns the master's R2 `outputKey` + download URL
   (`{CONTROL_API_URL}/api/jobs/{id}/download`).

Inputs: `doc?` (NewsReportDoc), `resolution?` (`"1080p" | "1440p" | "4k"` or
`{width,height}`, default 1080p), `timeoutSeconds?` (poll budget, default 1200).

### Environment

| Var | Default | Purpose |
|---|---|---|
| `CONTROL_API_URL` | `https://las-control-api.tech-sumit.workers.dev/api` | Base URL of the **deployed** control-api Worker. |

> Point this at the **deployed** Worker, not `wrangler dev` — local dev has
> isolated D1/R2, so cloned voices won't be found on the GPU pod.

### Prerequisites

`render_master` is the only newsroom tool that needs the **GPU plane** online:

1. A reachable **control-api** (set `CONTROL_API_URL`, or use the default deploy).
2. A **running GPU pod** the Worker can dispatch to — spawn one with
   `scripts/gpu/spawn-pod.sh` and confirm `/engine-three/health` reports
   `wysiwygScene: true`. Stop it when idle (an idle H100 dominates cost).

### Graceful degradation

The handler never throws out of the MCP server. Each failure mode returns an
`isError` ToolResult that names the prerequisite and includes the underlying
error:

- control-api unreachable / job submission rejected → explains the deploy + pod
  requirement with the HTTP error;
- the job ends `failed` → returns the job's error and the inspect URL;
- the poll budget elapses (e.g. a cold/offline pod) → reports the last status
  and the inspect URL;
- no doc + no connected studio → asks for a `doc` or `connect_studio`.

## External media generation (Phase 2 — `generate_image` / `generate_audio`)

`src/tools/external.ts` adds two tools that call an **external provider's HTTP
API**, save the generated media into the transport work dir, register it as a
served asset (`assetUrl` / `GET /asset/<id>`), and return the served URL + local
path:

| Tool | Provider | What it does |
|---|---|---|
| `generate_image` (`prompt`, `ratio?`) | **Runway Dev API** (`text_to_image`) | POSTs a `text_to_image` task, **polls** the task to `SUCCEEDED`, downloads the result image, saves + serves it. Default ratio `1920:1080`. |
| `generate_audio` (`prompt`, `durationSec?`) | **ElevenLabs** sound-generation (default) **or** a generic `AUDIO_API_*` endpoint | POSTs the prompt, reads back audio bytes, saves + serves them. |

Each provider call lives in a small **swappable `client` function**
(`runwayGenerateImage`, `elevenLabsGenerateAudio`, `genericGenerateAudio`) so the
provider/endpoint is easy to retarget — the API base, model id and API version
are plain constants (overridable via env, see below).

### Environment

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `RUNWAY_API_KEY` | `generate_image` | — (**required**) | Runway Dev API key (`https://dev.runwayml.com`). Sent as `Authorization: Bearer …` with an `X-Runway-Version` header. |
| `RUNWAY_API_BASE` | `generate_image` | `https://api.dev.runwayml.com/v1` | Runway API base URL. |
| `RUNWAY_API_VERSION` | `generate_image` | `2024-11-06` | Value of the `X-Runway-Version` header. |
| `RUNWAY_IMAGE_MODEL` | `generate_image` | `gen4_image` | Runway image model id. |
| `ELEVENLABS_API_KEY` | `generate_audio` | — | ElevenLabs API key (default audio provider — sound-generation). Sent as `xi-api-key`. |
| `ELEVENLABS_API_BASE` | `generate_audio` | `https://api.elevenlabs.io/v1` | ElevenLabs API base URL. |
| `AUDIO_API_URL` | `generate_audio` | — | Generic audio endpoint. **If set, it takes precedence over ElevenLabs.** POSTed `{ prompt, duration_seconds }`, expects audio bytes back. |
| `AUDIO_API_KEY` | `generate_audio` | — | Bearer token for `AUDIO_API_URL` (required when `AUDIO_API_URL` is set). |

### Graceful degradation

Neither handler throws out of the MCP server. If the needed API key env var is
**missing**, the tool returns an `isError` ToolResult that **names the exact env
var to set** and describes what it would have done — it does **not** crash:

- `generate_image` with no `RUNWAY_API_KEY` → asks for `RUNWAY_API_KEY`.
- `generate_audio` with no provider → asks for `ELEVENLABS_API_KEY` **or**
  `AUDIO_API_URL` + `AUDIO_API_KEY`; if `AUDIO_API_URL` is set but
  `AUDIO_API_KEY` is missing, it names `AUDIO_API_KEY` specifically.

HTTP / poll / download errors (a non-2xx from the provider, a `FAILED` task, a
timed-out poll, an undownloadable result) also return an `isError` result
carrying the provider's status + message.

## Tier-2 generators: montage + music + post (NM-8)

Three local A/V generators run **in the MCP process** by spawning `ffmpeg` and
`python3`. They produce assets (served by the upload HTTP server, see Ports) that
can be loaded onto the studio wall or finished into a broadcast master.

| Tool (module) | Asset module | What it does |
|---|---|---|
| `build_backscreen_montage` (`tools/montage.ts`) | `assets/montage.ts` → `buildMontage()` | ffmpeg the broadcast-card PNGs (from NM-7's `generate_backscreen_cards`) into a **silent 1920x1080 crossfade montage MP4** (slow `xfade`, ~5.5 s/card, 1 s crossfade), serve it, **and** `callBridge('setBackscreenMedia', { url })` so it plays **live on the studio back-wall**. Returns the montage URL + path. |
| `generate_music` (`tools/music.ts`) | `assets/music.ts` → `synthMusic()` | Spawn `python3` to synthesize a parametric **"breaking news" instrumental** (riser → impact → driving groove bed) as a 48 kHz stereo WAV. Returns the WAV URL + path. |
| `post_produce` (`tools/post.ts`) | `assets/post.ts` → `postProduce()` | ffmpeg post: optional **intro title card** (PNG held + Ken-Burns zoom) concatenated in front; **music bed** muxed (full over the intro, ducked under narration, faded out at the tail); optional **lower-third overlays** on the body. Returns the final MP4 URL + path. |

`build_backscreen_montage` and `post_produce` accept card / media refs as **asset
URLs, asset ids, or local paths** — each is resolved to a local path via
`assetPath()` (with an `/asset/<id>` URL fallback) before ffmpeg runs.

### `generate_music` parameters

| Param | Default | Meaning |
|---|---|---|
| `mood` | `breaking` | `breaking` \| `tense` \| `calm` \| `upbeat` — tunes master gain, impact brightness, and how hard the groove ducks over time. |
| `tempoBpm` | `120` | Groove tempo (drives beat/bar spacing), 60–200. |
| `bars` | `6` | Number of groove bars (chords) after the impact, 1–64. |
| `progression` | `['Cm','Ab','Eb','Bb','Cm','Ab']` | Chord names from the supported set (`Cm`, `Ab`, `Eb`, `Bb`), cycled to `bars`. |

Total clip length ≈ `2.5 s riser + 0.5 s lead-in + bars·(4·60/tempoBpm) + 1 s tail`.

### Runtime dependencies (Tier-2)

These tools shell out to native binaries that are **not** npm dependencies — they
must be on the host `PATH`:

- **`ffmpeg`** (with `ffprobe`) — for `build_backscreen_montage` and
  `post_produce` (the montage `xfade`, intro Ken-Burns clip, overlays, audio
  mux/duck/fade, and duration/audio-stream probing). macOS: `brew install ffmpeg`;
  Debian/Ubuntu: `apt-get install ffmpeg`.
- **`python3` + `numpy`** — for `generate_music` (the numpy synth, ported from the
  proven session `make_music.py`, is written to a temp `.py` in the work dir and
  run with `python3`). Install numpy with `pip3 install numpy`.

Each tool **degrades gracefully**: if `ffmpeg` / `python3` is missing (or `numpy`
is not importable, or a stage fails), the handler returns an `isError` ToolResult
naming the missing dependency and the underlying error — it never throws out of
the MCP server. `build_backscreen_montage` additionally still returns the montage
URL + path even if no studio is connected (it just notes the wall wasn't loaded).

## Extending (NM-4 / NM-5 / NM-6)

Tool modules export `ToolDef[]` and register through the same path as
`connect_studio`:

```ts
// src/tools/document.ts
import { defineTool } from '../server.js';
import { callBridge } from '../transport.js';
import { z } from 'zod';

export const documentTools = [
  defineTool({
    name: 'apply_newscast',
    description: 'Apply a full NewsReportDoc to the studio.',
    inputSchema: { doc: z.unknown() },
    async handler({ doc }) {
      await callBridge('applyNewscast', { doc });
      return { content: [{ type: 'text', text: 'Applied.' }] };
    },
  }),
];
```

Then add them to the registry in `src/server.ts`:

```ts
import { documentTools } from './tools/document.js';
export const TOOL_MODULES: ToolDef<any>[] = [connectStudioTool, ...documentTools];
```

`callBridge(cmd, params, { timeoutMs })` (from `transport.ts`) is the single
entry point a tool uses to reach the studio — it throws if no studio is
connected, on a studio-reported error, or on timeout (default 120s).
