# Spec: Modularize `apps/avatar-live/src/main.ts` into class-based controllers

**Date:** 2026-06-21
**Status:** approved design → implementation pending
**Scope:** `apps/avatar-live` only. Pure structural refactor — **no behavior changes, no new features.**

## 1. Problem
`src/main.ts` is **1768 LOC** and mixes ~16 unrelated responsibility clusters (DOM
binding, avatar loading, voices/TTS, the speak/perform engine, lighting, transform
gizmo, back-screen/cast, timeline editing, audio cues, projects/persistence,
recording). It's hard to read, reason about, and change; cross-cutting mutable
state (`speaking`, `render`, `currentAvatarId`, `performing`, `lipCfg`, `timeline`,
`player`) is tangled across the file.

## 2. Goal
Break `main.ts` into focused **class-based controllers**, each owning its DOM wiring
and its slice of state, so `main.ts` becomes a thin (~120-line) wiring layer that
builds a shared context, instantiates the controllers, and calls `.init()` on each.

**Non-goals:** no UI/visual changes, no new capabilities, no dependency changes, no
change to the on-disk project format or any network/R2 behavior. Output of the app
must be identical before and after.

## 3. Target architecture

### 3.1 `StudioContext` (built in `main.ts`, injected into every controller)
Holds the long-lived singletons + cross-cutting helpers:
- `stage: Stage`
- `studio` (from `buildNewsStudio()`)
- `avatar: AvatarController`
- `audio(): AudioContext` + `recordDest` accessor (today's `audioCtx()` / shared
  `sharedCtx`/`recordDest`)
- `log(msg: string): void`
- `dom`: the ~60 typed `getElementById` refs (moved to `src/app/dom.ts`)
- `isBusy(): boolean` — assigned by `main.ts` **after** controllers exist (back-edge)

`StudioContext` is a small class/object in `src/app/context.ts`. It carries no
feature state — only singletons and helpers.

### 3.2 Controllers (`src/app/*.ts`)
Each is a class constructed with `ctx` (and sibling controllers where noted). Each
exposes `init()` (binds DOM + initial population) and, where it participates in
projects, `serialize()` / `apply(doc)`. Each that can block input exposes
`get busy(): boolean`.

| Class (file) | Owns (state) | Constructor deps | Notable public API |
|---|---|---|---|
| `AvatarLibrary` (`avatarLibrary.ts`) | `avatarConfigs`, `currentAvatarId`, `adHocUrl`, `lipCfg` | `ctx` | `discover()`, `loadById(id)`, `loadUrl(url,label)`, `loadAdHoc()`, `applyLipCfg()`, `readLipSliders()`, `get currentId`, `serialize()/apply()` |
| `VoicePicker` (`voicePicker.ts`) | `activeTts`, `pendingVoiceId` | `ctx` | `populateVoices()`, `ttsOpts()`, `get activeTts`, `serialize()/apply()` |
| `Lighting` (`lighting.ts`) | `studioOn`, `idleMotionOn`, light values | `ctx` | `applyLights()`, `setPreset(name)`, `serialize()/apply()` |
| `AvatarTransform` (`avatarTransform.ts`) | gizmo, `gizmoOn`, `autoAlignOn` | `ctx` | `alignToFace()`, `resetView()`, `centerAvatar()`, `setGizmoMode/On()`, `serialize()/apply()` |
| `BackScreen` (`backScreen.ts`) | `backScreen`, `castStream`, `wallVideo` | `ctx` | `loadWallVideo()`, `cast()`, `stop()`, `revert()`, `serialize()/apply()` |
| `Recording` (`recording.ts`) | `recorder`, capture format | `ctx` | `toggle()`, `applyFormat()`, `get busy` |
| `TimelineEditor` (`timelineEditor.ts`) | `timeline`, `player`, `timelineUI`, `selectedCue`, `previewStart`, `playheadT`, `camRec`, audio-cue maps | `ctx` | `buildUI()`, `togglePreview()`, `seek(t)`, `captureCameraCue()`, `toggleCameraRecord()`, `showCueInspector()`, cue/audio edits, `scheduleAudioCues()/stopAudioCues()`, `get busy`, `serialize()/apply()` |
| `Performer` (`performer.ts`) | `speaking`, `render`, `performing`, `boundary`, `analyser`, narration | `ctx`, `{voices, recording, library, timeline}` | `perform(record)`, `stop()`, `buildNarration()`, `generateNarration()`, `setSpeakingUi()`, `get busy` |
| `ProjectStore` (`projectStore.ts`) | save/load/R2 indices | `ctx`, **all** controllers | `save()`, `loadNamed(name)`, `refreshSavedList()`, `loadSample()`, `serializeProject()`, `applyProject(doc)` |

`RealtimeSession` already exists; `main.ts` keeps instantiating it and wires its
callbacks to `avatar`/`Performer`.

### 3.3 Cross-cutting decisions
- **Single-owner state.** Each mutable value lives in exactly one controller, read
  via getters (`performer.busy`, `library.currentId`, …). No shared mutable bag.
- **Busy guard.** `Performer`, `TimelineEditor`, `Recording` each expose
  `get busy`. After construction, `main.ts` sets
  `ctx.isBusy = () => performer.busy || timeline.busy || recording.busy`. Replaces
  today's `takeActive()`; callers use `ctx.isBusy()`.
- **Decentralized persistence.** Today's monolithic `serializeProject`/`applyProject`
  split into per-controller `serialize()`/`apply(doc)`; `ProjectStore` only gathers
  and distributes the slices and handles R2/local IO + the saved-list UI. The
  produced `ProjectDoc` JSON shape is **unchanged** (back/forward compatible with
  existing saved projects + `samples/showcase.project.json`).
- **No circular deps.** Construction order: leaves → `AvatarLibrary` /
  `TimelineEditor` → `Performer` → `ProjectStore`. The only back-edge (`isBusy`) is
  injected as a function after all controllers exist.

### 3.4 File layout
```
src/
  main.ts                 # ~120 LOC: build ctx, new controllers, init() each, wire RealtimeSession
  app/
    dom.ts                # typed element refs → `dom`
    context.ts            # StudioContext
    avatarLibrary.ts
    voicePicker.ts
    lighting.ts
    avatarTransform.ts
    backScreen.ts
    recording.ts
    timelineEditor.ts
    performer.ts
    projectStore.ts
```
Existing non-`main` modules (`scene/`, `avatar/`, `timeline/`, `tts/`, `lipsync/`,
`capture/`, `storage/`, `session/`) are **unchanged** — controllers consume them.

## 4. Migration plan (incremental, one controller per step)
Each step is a pure code-move + adjust references; run `npm run typecheck` after
each. Order (least-coupled first):
1. `dom.ts` (element refs) + `context.ts` (singletons, `audio()`, `log`).
2. `Lighting`
3. `Recording`
4. `BackScreen`
5. `AvatarTransform`
6. `VoicePicker`
7. `AvatarLibrary`
8. `TimelineEditor`
9. `Performer` (inject the sibling controllers it needs)
10. `ProjectStore` (inject all controllers; move serialize/apply slices into owners)
11. Collapse `main.ts` to wiring; set `ctx.isBusy`.

Each step keeps the app runnable; no step changes behavior.

## 5. Verification (no CI in this repo)
- After **every** step: `npm run typecheck` (clean) + `npm run lint`.
- After the final step, manual studio smoke test (`npm run dev:avatar`):
  1. discover + switch avatars (dropdown), load a `.glb` by file + URL;
  2. write a script, **Speak (stream)** → audio plays + lip-sync + gestures;
  3. lip-sync calibration sliders + **Save to avatar**;
  4. **Record** → produces a downloadable clip;
  5. Timeline: toggle, preview, add a camera cue + audio cue, edit in cue inspector;
  6. transform: align-to-face, gizmo move/rotate, reset;
  7. lighting presets + studio toggle;
  8. back-screen: load a video, cast, revert;
  9. **Save** a project → reload page → **Load** it back (state restored); load the
     bundled sample.
- Diff check: the generated `dist/` behavior and the `ProjectDoc` JSON are unchanged.

## 6. Risks & mitigations
- **Hidden coupling surfaces during extraction** → incremental order + typecheck
  after each step catches broken references immediately.
- **Event-listener ordering / init timing** → preserve the existing init sequence in
  `main.ts`'s final wiring; `init()` order mirrors today's top-to-bottom execution.
- **Persistence regressions** → keep `ProjectDoc` shape byte-compatible; smoke-test
  save→load + the bundled sample explicitly.
- **`this` binding in DOM handlers** → controllers bind handlers in `init()` using
  arrow methods / `.bind(this)` to avoid `this` loss.
