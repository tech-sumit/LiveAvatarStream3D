# @las/avatar-live — Realtime 3D talking avatar (browser)

Stream a script → audio is generated → a browser-rendered 3D avatar speaks it
**lip-synced in realtime**. Built for AI news anchor / teacher / presenter use
cases. The WebGL canvas is the "virtual camera" and is recordable.

```bash
npm run dev:avatar      # from repo root → http://localhost:5175
```

No backend or GPU is required for the default path — it uses the browser's
Web Speech API for TTS and renders the avatar locally with Three.js.

## Editor / camera controls

- **Orbit / zoom / pan** the main view: drag to rotate, scroll to zoom, right-drag
  to pan (`OrbitControls`). The main camera is the one that gets **recorded**.
- **Virtual-camera PiP** (bottom-left): a fixed front-on framing of the head as a
  reference monitor while you orbit the main view. Hidden during recording.
- **Avatar position** X/Y/Z sliders move the avatar; **Center avatar** resets it.
- **Reset camera** re-frames; the **shot** dropdown applies framings from the
  shared shot-preset catalog in `@las/performer-core` (close, medium, wide,
  two-shot, over-the-shoulder, profile, hero-low, dutch, establish, push-in).

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
                                          └─ procedural head (zero-asset fallback rig)
                                                   │
                                          Stage (Three.js render loop + virtual camera)
                                                   │
                                          Recorder (canvas captureStream → .webm)
```

- **TTS sources** (`src/tts/`) — `WebSpeechTts` (local, instant, word-boundary
  events), `ElevenLabsTts` (real/cloned voice), and `ServerTts` (generic
  cloned-voice endpoint). All implement `TtsSource`, so the session is
  source-agnostic. The app auto-upgrades to ElevenLabs when it's configured.
- **Lipsync** (`src/lipsync/`) — `BoundaryLipsync` synthesizes mouth shapes from
  word letters timed to word-boundary events (used with Web Speech, which gives
  no routable audio). `AudioAnalyserLipsync` derives jaw + vowel shape from
  loudness + spectral centroid (used whenever real audio samples are available).
- **Avatar** (`src/avatar/`) — abstract `FaceChannels` (jawOpen, mouthWide,
  mouthRound, mouthClose, smile, frown, browRaise, blink) drive any rig.
  `MorphFaceRig` binds them to glTF morph targets across naming conventions
  (ARKit `jawOpen`, Oculus/RPM `viseme_*`, …); a procedural head rig
  (`proceduralHead.ts`) drives a primitive head so the app runs with no
  downloaded assets.
- **Session** (`src/session/`) — splits a script into sentences, speaks them
  back-to-back, supports live `enqueue()` (stream lines in) and `stop()`
  (barge-in).

## Voice (ElevenLabs)

For a real (or cloned) voice instead of the robotic browser voice, put your key
in `apps/avatar-live/.env`:

```bash
ELEVENLABS_API_KEY=sk_...      # NOT VITE_-prefixed — stays server-side
```

Restart `npm run dev:avatar`. The dev server proxies `/eleven/*` to ElevenLabs
and injects the key (it never reaches the browser, no CORS). The app detects this
on load, switches the voice dropdown to your ElevenLabs voices, and lip-syncs
from the real waveform. Without a key it falls back to browser Web Speech.
For production, front the API with an equivalent proxy/Worker.

## Body & gesture animation

Full-body rigged avatars (Avaturn, Avatar SDK, legacy Ready Player Me — they
share an RPM-compatible skeleton) get **skeletal body motion**: an idle stance and per-segment gesture
clips while speaking (`AvatarController` runs a `THREE.AnimationMixer`, crossfading
between clips). Pick a wider camera **shot** to see the gestures.

**DSL gesture mapping** (`src/avatar/gestures.ts`): each spoken segment resolves a
gesture → clip via `GESTURE_CLIPS`. Gestures come from:

- **Inline tags** in the script: `[wave] Hello! [point] Look here. [count] Three things.`
- **Keyword inference** otherwise (e.g. "hello"→wave, "look/this"→point,
  "first/three"→count, "I think"→hand_to_chest), defaulting to a talking gesture.

The DSL vocabulary mirrors `packages/protocol` (`wave, point, open_palms, count,
thumbs_up, nod, shrug, hand_to_chest, explain`). The RPM library has no literal
wave/point clips, so some map to distinct expressive-talking approximations.

Clips are **fetched, not committed** (RPM animation-library license: free use
*with RPM avatars*, no redistribution; the library is still published on GitHub
even though the RPM avatar service itself shut down in Jan 2026):

```bash
apps/avatar-live/scripts/fetch-animations.sh   # → public/animations/{idle,idle_calm,talk1..5}.glb
```

## Avatars & lip-sync requirements

Use the **avatar dropdown** to switch avatars.

Each avatar lives in its own folder, auto-discovered at runtime (no code to add one):
`public/<id>-model/{model.glb, config.json}` → indexed into `/avatars.json` by the
Vite avatar plugin. See **[AVATARS.md](AVATARS.md)** for the config schema, the
lip-sync calibration fields, and the avatar-sourcing plan.

The core roster is the **photoreal Avaturn base + in-Blender recolor variants**
(all share Avaturn's RPM-compatible rig + ARKit/Oculus visemes → identical body
animation **and** lip-sync), plus two custom-face experiments:

- **`avaturn-model`** — the photoreal Avaturn base (Type-2 export).
- **`avaturn-anchor2-model`**, **`avaturn-anchor3-model`** — recolored anchors
  (hair/skin/outfit), generated from the base via `scripts/avatar-variant.py`.
- **`ai-anchor-model`** — the Avaturn anatomical base (eyes/teeth/tongue +
  visemes) wrapped to a generated person's face proportions and recolored.
- **`hunyuan-anchor-model`** — photo → Hunyuan3D head rigged onto the Avaturn
  skeleton with grafted teeth/tongue (jaw-bone lip-sync).

Model binaries are **fetched/generated, not committed** (size + generated-asset
terms); each folder's `config.json` is committed. Restore them with:

```bash
apps/avatar-live/scripts/fetch-avatars.sh   # fetch avaturn base + rebuild variants (needs Blender)
```

Add a new anchor: recolor the base into `public/<id>-model/model.glb` with
`scripts/avatar-variant.py` + a `config.json` (see AVATARS.md), or drop any
ARKit/Oculus-blendshape `.glb` into a new folder. Avaturn exports must be
**Type-2** (separate eyeballs + mouth cavity) or they have no blendshapes.

The app defaults to Avaturn when present, else the first discovered avatar. The
Avaturn base originates from the MIT-licensed [met4citizen/talkinghead](https://github.com/met4citizen/talkinghead)
repo; generated Avaturn avatars are subject to Avaturn's terms for production use.

**A model can only lip-sync if its face is animatable.** Loading an external
`.glb` resolves to one of three outcomes (shown in the log):

| The model has… | Result | Lip-sync quality |
|---|---|---|
| ARKit / Oculus **facial blendshapes** | `MorphFaceRig` | Full visemes + expression |
| A **jaw bone** (no blendshapes) | `JawBoneRig` | Open/close only |
| Neither (frozen face) | rejected, keeps current avatar | None — cannot talk |

Most generic imports — **Mixamo characters, Sketchfab/photogrammetry scans,
baked-animation captures** — have a *frozen face*: no jaw bone and no
blendshapes, so nothing can move the mouth. They will be rejected with an
explanation. (Mixamo rigs stop at a `Head` bone — there is no jaw.)

### Getting a realistic, lip-sync-ready avatar

Load via **Load .glb** (file) or paste a URL into the **Load** field:

- **Avaturn** — photoreal avatar from a selfie, ARKit + Oculus-viseme
  blendshapes. Export must be **Type-2** (Type-1 has no face morphs).
- **Avatar SDK / MetaPerson** — photo → GLB with ARKit-compatible morphs +
  visemes (REST API, scriptable).
- **Character Creator 4 / iClone**, **Apple ARKit-rigged heads**,
  **MetaHuman** exported to glTF (via Blender) with ARKit shape keys.
- **Ready Player Me** — **dead for new avatars**: the service shut down
  Jan 31, 2026 (Netflix acquisition), and existing avatars are licensed
  non-commercial. Previously exported RPM `.glb`s (made with
  `?morphTargets=ARKit,Oculus Visemes`) still load and lip-sync, and the
  app's RPM-compatible skeleton/animation support is unaffected.

See **[AVATARS.md](AVATARS.md)** for the full ranked list of sources with
verified morph compatibility and license notes.

### Adding lip-sync to a model that lacks it

It's a content-pipeline step, not runtime: open the model in **Blender** and add
ARKit shape keys (manually or with an add-on like FaceIt), or bake facial
animation with **NVIDIA Audio2Face**, then export glTF **with morph targets**.

## ARKit full-face frames (Audio2Face-style)

The rig can drive the avatar's **entire face** (jaw, visemes, brows, blinks,
emotion) from ARKit blendshape name→weight frames — the output format of tools
like NVIDIA Audio2Face-3D — via `MorphFaceRig.applyNamed()` /
`AvatarController.setNamedFace()`. The dedicated in-app A2F demo clients and
GPU wrapper service were removed; the rig hooks remain for timeline-driven
full-face playback.

> Compressed avatars work out of the box — the loader wires Draco, meshopt, and
> KTX2/basis decoders (served from `public/decoders/`).

## Cloned voice (production path)

Set `VITE_TTS_URL` to a backend route that accepts `{ text, voiceId }` and
returns audio bytes (wav/mp3). The app switches to amplitude-accurate lipsync
and the recorder can mux the audio track. The control plane does not ship a
TTS endpoint — bring your own route (the built-in ElevenLabs proxy above
covers the common case).

## Recording

**Record camera** captures the canvas (the virtual camera) to a `.webm`.
Web Speech audio is not capturable by the browser, so local-demo clips are
video-only; the cloned-voice (Web Audio) path can include audio.

### Export

- **⬇ Export MP4** renders the script frame-exactly **offline** (WebCodecs + Mediabunny)
  to a `.mp4` at the selected resolution (720p–4K, vertical, square) in H.264 (default)
  or H.265 (when the browser supports it). Audio (cloned-voice narration) is muxed in
  sync. The preview may freeze during export — it renders on the main thread.
- **● Quick preview (webm)** is the old realtime `MediaRecorder` capture, kept for a
  fast throwaway preview. Web Speech audio is not capturable; use a cloned voice for
  audio in the exported MP4.

### Look (camera filters)

A post-processing "look" (pmndrs `postprocessing`) is applied to the viewport **and**
the captured output, so the exported MP4 inherits it. Pick a preset (Broadcast default,
Flat, Cinematic, Warm, Noir) or tune Bloom / Contrast / Saturation / Vignette / Grain;
the look is saved in the project. Pipeline: scene → Bloom → ACES tone map → contrast /
saturation / vignette / film-grain → SMAA. Tone mapping is ACES (three 0.152.2; AgX /
Neutral need a three upgrade). `PostProcessingSpec` lives in `@las/protocol` so the look
is part of the shared contract.

### Newscast script (import)

Import a `NewsReportDoc` (v2 JSON, `@las/protocol`) via the project/timeline file input to
configure the whole editor at once: anchor + voice, the script (sections → beats with inline
`[emotion][gesture]` tags), headline, look, lighting, back-screen, and camera/motion/music
cues. Then **Generate** + **⬇ Export MP4**. See `public/samples/showcase.newscast.json` and
`docs/specs/2026-06-21-newscast-dsl-design.md`. MVP supports a `rundown` of READER/VO sections;
acts/graphics/ticker/transitions/`.ncast` text are V2.
