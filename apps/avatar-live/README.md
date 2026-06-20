# @las/avatar-live — Realtime 3D talking avatar (browser)

Stream a script → audio is generated → a browser-rendered 3D avatar speaks it
**lip-synced in realtime**. Built for AI news anchor / teacher / presenter use
cases. The WebGL canvas is the "virtual camera" and is recordable.

```bash
npm run dev:avatar      # from repo root → http://localhost:5175
```

No backend or GPU is required for the default path — it uses the browser's
Web Speech API for TTS and renders the avatar locally with Three.js.

## How it works

```
script text ──► RealtimeSession ──► TtsSource ──► (audio)
                     │                   │
                     │ per-word/         └─► AudioAnalyserLipsync ─┐
                     │ per-sample cues                            │
                     └─► BoundaryLipsync ───────────────────────► MouthCue
                                                                   │
                                          AvatarController.update ─┘
                                          (smoothing + blink + idle + emotion)
                                                   │
                                          FaceRig.apply(channels)
                                          ├─ MorphFaceRig  (glTF ARKit/Oculus blendshapes)
                                          └─ ProceduralFaceRig (zero-asset fallback head)
                                                   │
                                          Stage (Three.js render loop + virtual camera)
                                                   │
                                          Recorder (canvas captureStream → .webm)
```

- **TTS sources** (`src/tts/`) — `WebSpeechTts` (local, instant, word-boundary
  events) and `ServerTts` (cloned voice; POSTs to `VITE_TTS_URL`, plays via Web
  Audio so lipsync reads the real waveform). Both implement `TtsSource`, so the
  session is source-agnostic.
- **Lipsync** (`src/lipsync/`) — `BoundaryLipsync` synthesizes mouth shapes from
  word letters timed to word-boundary events (used with Web Speech, which gives
  no routable audio). `AudioAnalyserLipsync` derives jaw + vowel shape from
  loudness + spectral centroid (used whenever real audio samples are available).
- **Avatar** (`src/avatar/`) — abstract `FaceChannels` (jawOpen, mouthWide,
  mouthRound, mouthClose, smile, frown, browRaise, blink) drive any rig.
  `MorphFaceRig` binds them to glTF morph targets across naming conventions
  (ARKit `jawOpen`, Oculus/RPM `viseme_*`, …); `ProceduralFaceRig` drives a
  primitive head so the app runs with no downloaded assets.
- **Session** (`src/session/`) — splits a script into sentences, speaks them
  back-to-back, supports live `enqueue()` (stream lines in) and `stop()`
  (barge-in).

## Using a real metahuman avatar

Drop a glTF/GLB with **ARKit or Oculus (Ready Player Me) blendshapes** into
`public/avatars/` (or use **Load .glb** in the UI). `MorphFaceRig` auto-binds
whatever mouth morphs it finds; if there are none it keeps the procedural head
and logs a notice. Ready Player Me avatars work out of the box.

## Cloned voice (production path)

Set `VITE_TTS_URL` to a backend route that accepts `{ text, voiceId }` and
returns audio bytes (wav/mp3). The app switches to amplitude-accurate lipsync
and the recorder can mux the audio track. See
`docs/specs/2026-06-20-realtime-avatar-live.md` for the planned control-api
`POST /api/tts` route and director-LLM streaming integration.

## Recording

**Record camera** captures the canvas (the virtual camera) to a `.webm`.
Web Speech audio is not capturable by the browser, so local-demo clips are
video-only; the cloned-voice (Web Audio) path can include audio.
