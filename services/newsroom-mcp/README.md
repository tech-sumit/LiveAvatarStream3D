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
