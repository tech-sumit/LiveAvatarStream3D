# @las/newsroom-mcp

A stdio **Model Context Protocol** server that generates **newscast assets**:
broadcast graphics, back-screen montages, music beds, post-produced masters, and
external-provider media. Generated files are written to a work dir and served
read-only at `http://127.0.0.1:9778/asset/<id>` so the browser studio can load
them.

## Scope: asset generation only (studio control moved to WebMCP)

This service **no longer controls the studio**. Its former studio-control
surface — the Studio Bridge WS transport on `127.0.0.1:9777`, the HTTP upload
sink (`POST /upload/...`) that received studio screenshots/exports, and every
tool that round-tripped the studio (`connect_studio`, `set_*`, cue/timeline
tools, `screenshot`, `preview`, `export_mp4`, `execute_js`,
`set_newscast`/`patch_newscast`/`validate_newscast`, the `webmcp_*` wrappers,
and the catalog/live-state resources) — was **superseded by the studio's own
in-browser WebMCP server** (`apps/avatar-live/src/mcp/`). See
[`docs/specs/2026-06-25-webmcp-studio-control-design.md`](../../docs/specs/2026-06-25-webmcp-studio-control-design.md).

The split now is:

- **Studio control** → the studio page's WebMCP tools (`navigator.modelContext`),
  driven from an MCP client via a WebMCP bridge (e.g. `mcp-webmcp` or
  chrome-devtools).
- **Asset generation** → this server. Tools return the generated asset's served
  `url` + local `path`; **the caller applies it in the studio** via the studio's
  WebMCP tools (e.g. pass a montage `url` to `set_backscreen_media`).

## Tools

| Tool | Module | What it does |
|---|---|---|
| `generate_graphics` | `tools/graphics.ts` | Render an explicit list of broadcast back-wall cards (1920x1080 PNGs, node-canvas). Returns each card's served URL + path. |
| `generate_backscreen_cards` | `tools/graphics.ts` | Derive + render the standard breaking/what/why/numbers/quote/developing card set from a story's fields. Returns ordered URLs (ready for `build_backscreen_montage`) + paths. |
| `build_backscreen_montage` | `tools/montage.ts` | ffmpeg the cards into a silent 1920x1080 crossfade montage MP4 and serve it. Returns the `url` to apply via the studio's WebMCP `set_backscreen_media`. Requires `ffmpeg`. |
| `generate_music` | `tools/music.ts` | Synthesize a parametric "breaking news" instrumental bed (riser → impact → groove) as a 48 kHz stereo WAV via `python3` + numpy. |
| `post_produce` | `tools/post.ts` | Finish a rendered newscast MP4: optional intro title card (Ken-Burns), music bed (ducked under narration), lower-third overlays. Requires `ffmpeg`. |
| `generate_image` | `tools/external.ts` | Runway Dev API text→image: submit a `text_to_image` task, poll to `SUCCEEDED`, download, save + serve. Needs `RUNWAY_API_KEY`. |
| `generate_audio` | `tools/external.ts` | ElevenLabs sound-generation (default) or a generic `AUDIO_API_URL` + `AUDIO_API_KEY` endpoint. Saves + serves the audio. |

Every tool returns the asset's **served URL** (`http://127.0.0.1:9778/asset/<id>`)
and **local path**. None of them touch the studio.

## Resources

| URI | Contents |
|---|---|
| `newsroom://assets/generated` | Every asset this server has generated and is serving: `{ id, url, path }[]` plus the work dir. |

## Ports

| Port | Server | Purpose |
|------|--------|---------|
| `127.0.0.1:9778` | HTTP | `GET /asset/<id>` streams a generated asset (permissive CORS so the browser studio can fetch it). Read-only; loopback only. |

## Build & run

```bash
# from the repo root
npm install
npm run build --workspace @las/newsroom-mcp      # tsc → dist/
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

## Smoke test

```bash
npm run build --workspace @las/newsroom-mcp
npm run smoke --workspace @las/newsroom-mcp
```

`src/scripts/smoke.ts` spawns the built server over stdio with a real MCP
client and PASSes only if the tool surface is exactly the seven asset tools and
the `newsroom://assets/generated` resource reads back cleanly.

## Environment

| Var | Used by | Default | Purpose |
|---|---|---|---|
| `RUNWAY_API_KEY` | `generate_image` | — (**required**) | Runway Dev API key (`https://dev.runwayml.com`). |
| `RUNWAY_API_BASE` | `generate_image` | `https://api.dev.runwayml.com/v1` | Runway API base URL. |
| `RUNWAY_API_VERSION` | `generate_image` | `2024-11-06` | `X-Runway-Version` header value. |
| `RUNWAY_IMAGE_MODEL` | `generate_image` | `gen4_image` | Runway image model id. |
| `ELEVENLABS_API_KEY` | `generate_audio` | — | ElevenLabs API key (default audio provider). |
| `ELEVENLABS_API_BASE` | `generate_audio` | `https://api.elevenlabs.io/v1` | ElevenLabs API base URL. |
| `AUDIO_API_URL` | `generate_audio` | — | Generic audio endpoint. If set, takes precedence over ElevenLabs. |
| `AUDIO_API_KEY` | `generate_audio` | — | Bearer token for `AUDIO_API_URL`. |

`generate_image` / `generate_audio` **degrade gracefully**: with no API key set
they return an `isError` result naming the exact env var — they never crash the
server.

## Native runtime dependencies

Not npm deps — must be on the host `PATH`:

- **`ffmpeg`** — `build_backscreen_montage`, `post_produce`. macOS:
  `brew install ffmpeg`.
- **`python3` + `numpy`** — `generate_music` (`pip3 install numpy`).

Each tool degrades gracefully with an `isError` result naming the missing
dependency.
