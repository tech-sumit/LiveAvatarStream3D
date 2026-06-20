# Realtime 3D talking avatar — browser-rendered (`apps/avatar-live`)

**Date:** 2026-06-20
**Status:** v1 implemented and verified locally (procedural head + Web Speech).
**Goal:** stream a script → audio generated → a 3D avatar speaks it lip-synced in
realtime, for AI news anchor / teacher / presenter use cases.

## Decision: browser-side rendering

Two architectures were considered for "realtime 3D metahuman with live lipsync":

| | **Browser-side (chosen)** | Server-side (GPU pod) |
|---|---|---|
| Render | Three.js in the browser | engine-three headless on H100 |
| Server streams | TTS audio + (optional) viseme timeline | encoded video frames |
| Encode/transport | none (canvas is the camera) | NVENC → WHIP → Cloudflare SFU |
| GPU pod | not required (light TTS only) | required, always-on |
| Latency | ~audio-generation time | render + encode + SFU (~150ms) |
| Testable locally | yes, today | needs live pod + NVENC + WHIP-from-Node |

Browser-side reuses the DSL/segment concepts and engine-three's viseme/morph
logic, drops the hardest/least-testable parts (NVENC, WHIP publisher, realtime
headless loop), and is the right fit for talking-head anchor/teacher use cases.
The server-side path remains valid for film-grade output and is unchanged
(`services/engine-three` offline render + `services/gpu/realtime` 2D MuseTalk).

## What exists today vs. this app

- **`services/gpu/realtime`** — full WebRTC realtime path, but **2D** (MuseTalk
  face video over Cloudflare SFU).
- **`services/engine-three`** — real 3D with glTF blendshapes + viseme/A2F
  lipsync + virtual camera, but **offline** (renders a whole MP4 and stops).
- **`apps/avatar-live` (new)** — the missing bridge: **realtime 3D**, browser
  rendered, streaming script → spoken lipsync.

## Architecture

See `apps/avatar-live/README.md` for the data-flow diagram and module map.
Key contracts:

- `FaceChannels` — avatar-agnostic face state; one lipsync pipeline drives any
  rig (`MorphFaceRig` for glTF ARKit/Oculus blendshapes, `ProceduralFaceRig`
  for the zero-asset fallback head).
- `TtsSource` — `WebSpeechTts` (local/instant) and `ServerTts` (cloned voice via
  `VITE_TTS_URL`). Session is source-agnostic.
- `RealtimeSession` — sentence queue with live `enqueue()` (stream-in) and
  `stop()` (barge-in).

The browser `MorphFaceRig` is the sibling of engine-three's `face/morphApply.ts`;
emotion vocabulary mirrors `packages/protocol` `dsl.ts`.

## Verified (Jun 20, 2026)

- `npm run typecheck` + `vite build` clean.
- Loaded at `http://localhost:5175`: anchor bust renders, voices populate,
  **Speak (stream)** drives realtime mouth motion (open on words, closed
  between), idle blinks, no console errors.

## Backlog / next steps

| # | Task | Notes |
|---|---|---|
| 1 | **Cloned-voice TTS route** | `POST /api/tts { text, voiceId } → audio/wav` on control-api, proxied to GPU `voice/synth`. Unlocks `ServerTts` + amplitude-accurate `AudioAnalyserLipsync` + audio in recordings. |
| 2 | **Director LLM streaming** | Reuse SessionDO's DSL stream: feed `StreamedSegment` (text+emotion+gesture+camera) into `RealtimeSession.enqueue()` so the avatar speaks an LLM-generated script live and emotes per beat. |
| 3 | **Ship a hero RPM/ARKit avatar** | Add a blendshape `.glb` to `public/avatars/` and auto-load it (replaces procedural head). |
| 4 | **Phoneme/viseme timeline from server** | When server TTS returns phoneme timings, prefer a `VisemeTimelineLipsync` over amplitude for crisper consonants. |
| 5 | **Mic → STT → LLM loop** | Make it conversational (anchor answers questions) — STT already exists in `services/gpu/realtime/stt.py`. |
| 6 | **Gesture/body animation** | Map DSL `gesture`/`posture` to body clips (montages exist in engine-three) for a half-body presenter. |
| 7 | **Host on Cloudflare Pages** | `npm run build --workspace @las/avatar-live`. |

## How to run

```bash
npm run dev:avatar     # http://localhost:5175
# optional cloned voice:
VITE_TTS_URL=https://.../api/tts npm run dev:avatar
```
