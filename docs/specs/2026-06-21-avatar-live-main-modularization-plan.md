# avatar-live `main.ts` Modularization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `apps/avatar-live/src/main.ts` (1768 LOC) into class-based controllers so `main.ts` becomes a ~120-line wiring layer, with **zero behavior change**.

**Architecture:** A `StudioContext` (singletons + `dom` refs + `log` + `audio()` + `isBusy()`) is injected into ~9 controller classes under `src/app/`. Each controller owns its DOM wiring, its slice of mutable state (read via getters), and — where it participates in projects — `serialize()/apply(doc)`. `main.ts` builds the context, instantiates controllers in dependency order, sets `ctx.isBusy`, and calls `init()` on each.

**Tech Stack:** Vanilla TypeScript + Three.js, Vite. No test runner in this workspace — verification is `npm run typecheck` (must stay clean) + `npm run lint`, plus a final manual smoke test in `npm run dev:avatar`.

**Spec:** `docs/specs/2026-06-21-avatar-live-main-modularization.md`

---

## Conventions for every task

- **This is a pure code-move refactor.** Move existing function bodies/state verbatim into class methods/fields; do **not** rewrite logic. The only edits are: `function foo()` → `foo = (): T => {...}` (arrow class field, to preserve `this`-free behavior and binding), top-level `const x` → `private x` field, and references like `avatarSel` → `this.ctx.dom.avatarSel`, `log(...)` → `this.ctx.log(...)`, `audioCtx()` → `this.ctx.audio()`, `stage`/`avatar`/`studio` → `this.ctx.stage` / `.avatar` / `.studio`.
- **`this` safety:** declare moved functions as **arrow-function class fields** (`name = (...) => {...}`) so they keep working when passed as event handlers without `.bind`.
- **Run after every task** (the "test"):
  - `npm run typecheck` → Expected: no errors.
  - `npm run lint` → Expected: no new errors.
- **Commit after every task** (messages below).
- Work from repo root: `/Users/sumitagrawal/CODE/sumit/n8n/projects/LiveAvatarStream3D`. Typecheck one workspace: `npm run typecheck` runs all; that's fine.
- Line ranges below refer to the **current** `main.ts`; they shift as you extract — locate by symbol name, not absolute line.

---

## File structure (created across the plan)

```
apps/avatar-live/src/
  main.ts                 # collapses to wiring (Task 11)
  app/
    dom.ts                # Task 1 — typed element refs
    context.ts            # Task 1 — StudioContext
    lighting.ts           # Task 2
    recording.ts          # Task 3
    backScreen.ts         # Task 4
    avatarTransform.ts    # Task 5
    voicePicker.ts        # Task 6
    avatarLibrary.ts      # Task 7
    timelineEditor.ts     # Task 8
    performer.ts          # Task 9
    projectStore.ts       # Task 10
```

---

## Task 1: Foundations — `dom.ts` + `context.ts`

**Files:**
- Create: `apps/avatar-live/src/app/dom.ts`
- Create: `apps/avatar-live/src/app/context.ts`
- Modify: `apps/avatar-live/src/main.ts` (replace the inline `$()` refs + `log`/`audioCtx` with imports)

- [ ] **Step 1: Create `dom.ts`** — move every `getElementById` binding out of `main.ts`.

```ts
// apps/avatar-live/src/app/dom.ts
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

/** All studio DOM refs, bound once. */
export function bindDom() {
  return {
    app: $('app'),
    stage: $('stage'),
    script: $<HTMLTextAreaElement>('script'),
    liveLine: $<HTMLTextAreaElement>('liveLine'),
    speak: $<HTMLButtonElement>('speak'),
    stop: $<HTMLButtonElement>('stop'),
    voice: $<HTMLSelectElement>('voice'),
    rate: $<HTMLInputElement>('rate'),
    pitch: $<HTMLInputElement>('pitch'),
    emotion: $<HTMLSelectElement>('emotion'),
    shot: $<HTMLSelectElement>('shot'),
    glb: $<HTMLInputElement>('glb'),
    avatarSel: $<HTMLSelectElement>('avatarSel'),
    glbUrl: $<HTMLInputElement>('glbUrl'),
    lipGain: $<HTMLInputElement>('lipGain'),
    lipJaw: $<HTMLInputElement>('lipJaw'),
    lipWide: $<HTMLInputElement>('lipWide'),
    lipRound: $<HTMLInputElement>('lipRound'),
    lipSmooth: $<HTMLInputElement>('lipSmooth'),
    lipTest: $<HTMLButtonElement>('lipTest'),
    lipSave: $<HTMLButtonElement>('lipSave'),
    lipDim: $<HTMLDivElement>('lipDim'),
    resetView: $<HTMLButtonElement>('resetView'),
    centerAvatar: $<HTMLButtonElement>('centerAvatar'),
    gizmoBtn: $<HTMLButtonElement>('gizmoBtn'),
    gizmoModes: $<HTMLDivElement>('gizmoModes'),
    moveMode: $<HTMLButtonElement>('moveMode'),
    rotateMode: $<HTMLButtonElement>('rotateMode'),
    loadUrl: $<HTMLButtonElement>('loadUrl'),
    record: $<HTMLButtonElement>('record'),
    download: $<HTMLAnchorElement>('download'),
    avatarStatus: $<HTMLSpanElement>('avatarStatus'),
    log: $<HTMLPreElement>('log'),
    pipFrame: $<HTMLDivElement>('pipFrame'),
    captureFormat: $<HTMLSelectElement>('captureFormat'),
    gateLabel: $<HTMLSpanElement>('gateLabel'),
    studioToggle: $<HTMLButtonElement>('studioToggle'),
    idleMotionToggle: $<HTMLButtonElement>('idleMotionToggle'),
    headline: $<HTMLInputElement>('headline'),
    lightPreset: $<HTMLSelectElement>('lightPreset'),
    lightKey: $<HTMLInputElement>('lightKey'),
    lightFill: $<HTMLInputElement>('lightFill'),
    lightRim: $<HTMLInputElement>('lightRim'),
    lightAmbient: $<HTMLInputElement>('lightAmbient'),
    exposure: $<HTMLInputElement>('exposure'),
    warmth: $<HTMLInputElement>('warmth'),
    projectName: $<HTMLInputElement>('projectName'),
    saveTimeline: $<HTMLButtonElement>('saveTimeline'),
    loadTimeline: $<HTMLButtonElement>('loadTimeline'),
    savedList: $<HTMLSelectElement>('savedList'),
    timelineFile: $<HTMLInputElement>('timelineFile'),
    cueInspector: $<HTMLDivElement>('cueInspector'),
    cueType: $<HTMLDivElement>('cueType'),
    cueStart: $<HTMLInputElement>('cueStart'),
    cueDur: $<HTMLInputElement>('cueDur'),
    cueSetView: $<HTMLButtonElement>('cueSetView'),
    cueDelete: $<HTMLButtonElement>('cueDelete'),
    cueAudio: $<HTMLDivElement>('cueAudio'),
    cueVol: $<HTMLInputElement>('cueVol'),
    cueFadeIn: $<HTMLInputElement>('cueFadeIn'),
    cueFadeOut: $<HTMLInputElement>('cueFadeOut'),
    alignFace: $<HTMLButtonElement>('alignFace'),
    autoAlign: $<HTMLButtonElement>('autoAlign'),
    screenUrl: $<HTMLInputElement>('screenUrl'),
    screenLoad: $<HTMLButtonElement>('screenLoad'),
    screenFile: $<HTMLInputElement>('screenFile'),
    screenCast: $<HTMLButtonElement>('screenCast'),
    screenStop: $<HTMLButtonElement>('screenStop'),
    camSource: $<HTMLButtonElement>('camSource'),
    audioFile: $<HTMLInputElement>('audioFile'),
    timeline: $<HTMLDivElement>('timeline'),
    timelineToggle: $<HTMLButtonElement>('timelineToggle'),
  };
}

export type Dom = ReturnType<typeof bindDom>;
```

> Cross-check: grep `main.ts` for every `\$\(['"]` and `getElementById` and ensure each id appears above. Add any missed ids before continuing.

- [ ] **Step 2: Create `context.ts`** — the injected singletons + helpers.

```ts
// apps/avatar-live/src/app/context.ts
import { Stage } from '../scene/stage.js';
import { buildNewsStudio } from '../scene/studio.js';
import { AvatarController } from '../avatar/avatarController.js';
import { bindDom, type Dom } from './dom.js';

export class StudioContext {
  readonly dom: Dom = bindDom();
  readonly stage = new Stage(this.dom.stage);
  readonly studio = buildNewsStudio();
  readonly avatar = new AvatarController();

  private sharedCtx: AudioContext | null = null;
  recordDest: MediaStreamAudioDestinationNode | null = null;

  /** Set by main.ts after controllers exist. */
  isBusy: () => boolean = () => false;

  log = (msg: string): void => {
    const el = this.dom.log;
    el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n${el.textContent ?? ''}`;
  };

  audio = (): AudioContext => {
    // MOVE the exact body of the current audioCtx() here (lines ~105-113),
    // replacing `sharedCtx`→`this.sharedCtx`, `recordDest`→`this.recordDest`.
    if (!this.sharedCtx) this.sharedCtx = new AudioContext();
    if (!this.recordDest) this.recordDest = this.sharedCtx.createMediaStreamDestination();
    return this.sharedCtx;
  };
}
```

> Copy the **real** `log` and `audioCtx` bodies from `main.ts` (lines ~86-113) — the snippets above mirror them; verify the studio scene attachment in the current `Stage`/`buildNewsStudio` wiring matches (today `main.ts` adds `studio` to the stage right after construction — keep that line in `main.ts` Task 11, or move it into `StudioContext` constructor if it currently runs unconditionally).

- [ ] **Step 3: Rewire `main.ts` to use the context** (interim — full collapse is Task 11).

In `main.ts`: delete lines ~24-84 (the `$` refs), ~86-90 (`log`), ~92-95 (singletons), ~103-113 (`audioCtx`). Add at top:

```ts
import { StudioContext } from './app/context.js';
const ctx = new StudioContext();
const { dom } = ctx;
const { stage, studio, avatar } = ctx;
const log = ctx.log;
const audioCtx = ctx.audio;
```
Then replace remaining bare `appEl`→`dom.app`, `scriptEl`→`dom.script`, etc. (Editor-wide find/replace per the `dom` keys.) Keep everything else working.

- [ ] **Step 4: Verify** — `npm run typecheck` (no errors) + `npm run lint`.
- [ ] **Step 5: Commit**

```bash
git add apps/avatar-live/src/app/dom.ts apps/avatar-live/src/app/context.ts apps/avatar-live/src/main.ts
git commit -m "refactor(avatar-live): extract dom.ts + StudioContext from main.ts"
```

---

## Task 2: `Lighting` controller

**Files:**
- Create: `apps/avatar-live/src/app/lighting.ts`
- Modify: `apps/avatar-live/src/main.ts`

**Move from `main.ts`:** `studioOn` (618), `idleMotionOn` (631), `mixColor` (640), `applyLights` (652), `LIGHT_PRESETS` (665), and the event listeners for `studioToggle`, `idleMotionToggle`, `lightPreset`, `lightKey/Fill/Rim/Ambient`, `exposure`, `warmth`.

- [ ] **Step 1: Create the class skeleton.**

```ts
// apps/avatar-live/src/app/lighting.ts
import type { StudioContext } from './context.js';

export class Lighting {
  private studioOn = true;
  private idleMotionOn = false;
  constructor(private ctx: StudioContext) {}

  // MOVE here: mixColor, applyLights, LIGHT_PRESETS (as private fields/methods,
  // arrow-function form), with stage/studio/avatar → this.ctx.stage/.studio/.avatar
  // and dom refs → this.ctx.dom.*

  serialize() { /* MOVE the lighting slice of serializeProject here */ return {}; }
  apply(doc: unknown) { /* MOVE the lighting slice of applyProject here */ }

  init(): void {
    const d = this.ctx.dom;
    // MOVE all lighting-related addEventListener wiring here.
    this.applyLights();
  }
  // applyLights/mixColor/LIGHT_PRESETS moved in as members
  private applyLights = (): void => { /* moved body */ };
}
```

- [ ] **Step 2: Delete the moved code from `main.ts`**; instantiate + init:

```ts
import { Lighting } from './app/lighting.js';
const lighting = new Lighting(ctx);
// ...later, in the init section: lighting.init();
```
Replace any remaining `applyLights()` calls elsewhere with `lighting`-owned calls (e.g. expose a public method if another module calls it; today only project-apply and init call it — both move).

- [ ] **Step 3: Verify** — `npm run typecheck` + `npm run lint`.
- [ ] **Step 4: Commit** — `git commit -am "refactor(avatar-live): extract Lighting controller"`

---

## Task 3: `Recording` controller

**Files:** Create `apps/avatar-live/src/app/recording.ts`; modify `main.ts`.

**Move from `main.ts`:** `CAPTURE_FORMATS` (813), `applyCaptureFormat` (827), `recorder` (938), `renderSrc` (942), `setRecUi` (944), `downloadClip` (949), and `record`/`captureFormat` listeners. Expose `get busy()` from the recorder's active flag.

- [ ] **Step 1: Class skeleton.**

```ts
// apps/avatar-live/src/app/recording.ts
import { Recorder } from '../capture/recorder.js';
import type { StudioContext } from './context.js';

export class Recording {
  private recorder: Recorder;
  constructor(private ctx: StudioContext) {
    // MOVE the `new Recorder(...)` construction here verbatim (deps: stage canvas,
    // ctx.audio()/recordDest, callbacks → this.setRecUi etc.)
  }
  get busy(): boolean { return this.recorder.active; } // match current Recorder API
  toggle = (): void => { /* MOVE record button handler body */ };
  applyFormat = (): void => { /* MOVE applyCaptureFormat body */ };
  private setRecUi = (on: boolean): void => { /* moved */ };
  init(): void {
    this.ctx.dom.record.addEventListener('click', this.toggle);
    this.ctx.dom.captureFormat.addEventListener('change', this.applyFormat);
    this.applyFormat();
  }
}
```
> Verify the real `Recorder` field for "is recording" (the spec calls it `recorder.active`; confirm against `src/capture/recorder.ts` and use the real name).

- [ ] **Step 2:** Delete moved code from `main.ts`; `const recording = new Recording(ctx); … recording.init();`. The `Performer` (Task 9) will receive `recording`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract Recording controller"`

---

## Task 4: `BackScreen` controller

**Files:** Create `apps/avatar-live/src/app/backScreen.ts`; modify `main.ts`.

**Move from `main.ts`:** `wallVideo` (689), `wallAudioWired` (693), `castStream` (694), `castAudioNode` (695), `backScreen` (697), `wireWallAudio` (706), `showOnWall` (718), `stopCast` (723), `loadWallVideo` (729), `revertScreen` (785), `updateCamSourceLabel` (797), and the `screenUrl/screenLoad/screenFile/screenCast/screenStop/camSource` listeners.

- [ ] **Step 1:** Class skeleton `BackScreen` with the above as private fields/arrow methods; `serialize()/apply()` for the back-screen slice; `init()` wires the screen buttons + sets initial cam-source label.
- [ ] **Step 2:** Delete from `main.ts`; `const backScreen = new BackScreen(ctx); … backScreen.init();`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract BackScreen controller"`

---

## Task 5: `AvatarTransform` controller

**Files:** Create `apps/avatar-live/src/app/avatarTransform.ts`; modify `main.ts`.

**Move from `main.ts`:** `faceWorld` (531), `autoAlignOn` (536), `gizmoProxy` (550), `chestY` (552), `syncGizmoToAvatar` (553), `gizmo`=`new TransformControls(...)` (559), `setGizmoMode` (575), `setGizmoOn` (582), `gizmoOn` (593), and `alignFace/autoAlign/gizmoBtn/moveMode/rotateMode/resetView/centerAvatar` listeners.

- [ ] **Step 1:** Class skeleton. Public methods other modules use: `alignToFace()`, `syncToAvatar()` (so `AvatarLibrary` can call it after loading a new avatar — today `main.ts` calls `syncGizmoToAvatar()` post-load). `serialize()/apply()` for avatar transform slice.
- [ ] **Step 2:** Delete from `main.ts`; `const transform = new AvatarTransform(ctx); … transform.init();`. Where `AvatarLibrary` is created (Task 7) it will call `transform.syncToAvatar()` after a load — for now leave the post-load call in `main.ts` calling `transform.syncToAvatar()`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract AvatarTransform controller"`

---

## Task 6: `VoicePicker` controller

**Files:** Create `apps/avatar-live/src/app/voicePicker.ts`; modify `main.ts`.

**Move from `main.ts`:** `ttsOpts` (321), `serverTtsUrl` (396), `activeTts` (397), `pendingVoiceId` (415), `voiceOptionExists` (416), `populateVoices` (420), and `voice/rate/pitch` listeners.

- [ ] **Step 1:** Class skeleton with public `ttsOpts()`, `get activeTts()`, `populateVoices()`, `serialize()/apply()` (selected voice id). `init()` wires voice/rate/pitch + calls `populateVoices()`.
- [ ] **Step 2:** Delete from `main.ts`; `const voices = new VoicePicker(ctx); … await voices.init()` (populateVoices is async — keep the await in main's init sequence).
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract VoicePicker controller"`

---

## Task 7: `AvatarLibrary` controller

**Files:** Create `apps/avatar-live/src/app/avatarLibrary.ts`; modify `main.ts`.

**Move from `main.ts`:** `loadAvatar` (115), `setupBodyAnimation` (140), `DEFAULT_LIP` (174), `LEGACY_AVATAR_IDS` (176), `avatarConfigs` (182), `currentAvatarId` (183), `adHocUrl` (184), `lipCfg` (185), `discoverAvatars` (187), `applyLipCfg` (220), `loadAvatarById` (230), `loadAdHocAvatar` (843), `readLipSliders` (887), `onLipSlider` (896), the `AvatarConfig` interface, and `avatarSel/glb/loadUrl/glbUrl/lip*` listeners.

- [ ] **Step 1:** Class skeleton.

```ts
// apps/avatar-live/src/app/avatarLibrary.ts
import type { StudioContext } from './context.js';
import type { AvatarTransform } from './avatarTransform.js';

export const DEFAULT_LIP = { gain: 1, jaw: 1, wide: 1, round: 1, smoothing: 0.2 };

export class AvatarLibrary {
  private avatarConfigs = new Map<string, AvatarConfig>();
  private _currentId: string | null = null;
  private adHocUrl: string | null = null;
  private lipCfg = { ...DEFAULT_LIP };
  constructor(private ctx: StudioContext, private transform: AvatarTransform) {}
  get currentId() { return this._currentId; }
  // MOVE: loadAvatar, setupBodyAnimation, discoverAvatars, applyLipCfg,
  // loadAvatarById, loadAdHocAvatar, readLipSliders, onLipSlider — as arrow members.
  // After a successful load, call this.transform.syncToAvatar().
  // Guard avatar switches with this.ctx.isBusy().
  serialize() { /* avatar id + lipCfg slice */ return {}; }
  async apply(doc: unknown) { /* restore avatar by id/url + lipCfg */ }
  async init(): Promise<void> { /* wire listeners; await this.discoverAvatars() */ }
}
```
> `AvatarLibrary` depends on `AvatarTransform` (to re-sync the gizmo post-load). Inject it. Move the post-load `transform.syncToAvatar()` call out of `main.ts` into the loader methods.

- [ ] **Step 2:** Delete from `main.ts`; `const library = new AvatarLibrary(ctx, transform); … await library.init();`. Replace `takeActive()` usages inside these methods with `this.ctx.isBusy()`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract AvatarLibrary controller"`

---

## Task 8: `TimelineEditor` controller

**Files:** Create `apps/avatar-live/src/app/timelineEditor.ts`; modify `main.ts`.

**Move from `main.ts`:** `demoTimeline` (284), `timeline` (307), `player` (308), `timelineUI` (316), `previewStart` (317), `playheadT` (318), `camRec` (319), `setSpeakingUi` (1255) [NOTE: `setSpeakingUi` is shared with Performer — see step note], `buildTimelineUI` (1263), `startPreview/stopPreview/togglePreview/seekPreview` (1287-1320), `captureCameraCue` (1321), `toggleCameraRecord` (1336), `selectedCue` (1378), `showCueInspector` (1379), `commitCueEdit` (1402), `commitAudioEdit` (1411), audio-cue block: `audioBuffers/audioBlobs/scheduledAudio` (1127-1129), `pruneAudioMaps` (1133), `addAudioClip` (1140), `scheduleAudioCues` (1178), `stopAudioCues` (1215), and `timelineToggle`, cue-inspector, `audioFile` listeners.

- [ ] **Step 1:** Class skeleton with `get busy()` (`previewStart !== null`), public `serialize()/apply()` (timeline duration + cues), `scheduleAudioCues()/stopAudioCues()` (Performer may call during record), `get timeline()` / `get player()` accessors, `init()`.
  - **`setSpeakingUi`:** this toggles speak/stop button UI and is used by both preview and perform. Put the **owning** copy in `Performer` (Task 9, it owns `speaking`) and have `TimelineEditor` call `ctx`-level... — simpler: keep `setSpeakingUi` as a small method on `Performer`, and pass a callback to `TimelineEditor` if it needs it. If `TimelineEditor` only needs it for preview start/stop, give `TimelineEditor` its own private `setPlayingUi()` for the preview button and leave speak/stop UI to `Performer`. Verify which buttons each path toggles in the current code and split accordingly (no shared mutation).
- [ ] **Step 2:** Delete from `main.ts`; `const timeline = new TimelineEditor(ctx); … timeline.init();`. Replace `takeActive()` → `this.ctx.isBusy()`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract TimelineEditor controller"`

---

## Task 9: `Performer` controller

**Files:** Create `apps/avatar-live/src/app/performer.ts`; modify `main.ts`.

**Move from `main.ts`:** `boundary` (263), `analyser` (264), `speaking` (265), `lastTalkClip` (266), `render`/`RenderState` (276), `narrationAudio` (280), `narrationSegs` (281), `renderSrc` if perform-owned, `buildNarration` (970), `generateNarration` (1034), `performing` (1047), `perform` (1048), `stopPerform` (1118), `setSpeakingUi` (1255, owning copy), `monoData` (958), and `speak/stop/liveLine` listeners.

- [ ] **Step 1:** Class skeleton.

```ts
// apps/avatar-live/src/app/performer.ts
import type { StudioContext } from './context.js';
import type { VoicePicker } from './voicePicker.js';
import type { Recording } from './recording.js';
import type { AvatarLibrary } from './avatarLibrary.js';
import type { TimelineEditor } from './timelineEditor.js';

export class Performer {
  private speaking = false;
  private performing = false;
  // MOVE: boundary, analyser, render, narration*, lastTalkClip
  constructor(
    private ctx: StudioContext,
    private deps: { voices: VoicePicker; recording: Recording; library: AvatarLibrary; timeline: TimelineEditor },
  ) {}
  get busy(): boolean { return this.performing || this.render != null; }
  // MOVE perform/stop/buildNarration/generateNarration/setSpeakingUi as arrow members,
  // replacing ttsOpts()/activeTts → this.deps.voices.*, lipCfg → this.deps.library lip getter,
  // audio cue scheduling → this.deps.timeline.scheduleAudioCues(...), recorder → this.deps.recording.
  init(): void { /* wire speak/stop/liveLine listeners */ }
}
```
- [ ] **Step 2:** Delete from `main.ts`; `const performer = new Performer(ctx, { voices, recording, library, timeline }); … performer.init();`. Immediately after, wire the busy guard:

```ts
ctx.isBusy = () => performer.busy || timeline.busy || recording.busy;
```
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract Performer controller + wire isBusy"`

---

## Task 10: `ProjectStore` controller

**Files:** Create `apps/avatar-live/src/app/projectStore.ts`; modify `main.ts`.

**Move from `main.ts`:** `PROJECT_PREFIX/LOCAL_INDEX/SAMPLE_*` (1452-1455), `sanitize` (1456), `r2On` (1457), `assetUrl` (1461), `fetchAssetBlob` (1464), `listLocal` (1470), `refreshSavedList` (1477), `loadSample` (1507), `serializeProject` (1519), `uploadAssets` (1553), `downloadJson` (1580), `saveProject` (1590), `applyTimelineDoc` (1618), `applyProject` (1632), `loadNamed` (1711), and `saveTimeline/loadTimeline/savedList/timelineFile` listeners.

- [ ] **Step 1:** Class skeleton.

```ts
// apps/avatar-live/src/app/projectStore.ts
import type { StudioContext } from './context.js';
import type { AvatarLibrary } from './avatarLibrary.js';
import type { VoicePicker } from './voicePicker.js';
import type { Lighting } from './lighting.js';
import type { AvatarTransform } from './avatarTransform.js';
import type { BackScreen } from './backScreen.js';
import type { TimelineEditor } from './timelineEditor.js';

export class ProjectStore {
  constructor(
    private ctx: StudioContext,
    private c: { library: AvatarLibrary; voices: VoicePicker; lighting: Lighting;
                transform: AvatarTransform; backScreen: BackScreen; timeline: TimelineEditor },
  ) {}
  // serializeProject(): gather this.c.library.serialize(), .voices.serialize(), etc.
  //   into the SAME ProjectDoc shape as today (verify field names byte-for-byte).
  // applyProject(doc): distribute slices to each this.c.* .apply(slice).
  // MOVE: refreshSavedList, loadSample, saveProject, loadNamed, R2 IO, downloadJson.
  init(): void { /* wire save/load/savedList/timelineFile; await refreshSavedList() */ }
}
```
> **Critical:** the `ProjectDoc` JSON must be identical to today. Before deleting `serializeProject`/`applyProject`, copy their exact field assignments into the per-controller `serialize()/apply()` you stubbed in Tasks 2-8, so the gathered doc matches field-for-field. Smoke-test save→load + the bundled `samples/showcase.project.json` in Task 11.

- [ ] **Step 2:** Delete from `main.ts`; `const projects = new ProjectStore(ctx, { library, voices, lighting, transform, backScreen, timeline }); … await projects.init();`.
- [ ] **Step 3: Verify** — typecheck + lint.
- [ ] **Step 4: Commit** — `"refactor(avatar-live): extract ProjectStore controller"`

---

## Task 11: Collapse `main.ts` + RealtimeSession + smoke test

**Files:** Modify `apps/avatar-live/src/main.ts`.

- [ ] **Step 1:** `main.ts` should now contain only: imports, `const ctx = new StudioContext()`, controller construction in dependency order (leaves → library/timeline → performer → projectStore), `ctx.isBusy = …`, the `RealtimeSession` construction (move its callbacks to call `performer`/`ctx.avatar` methods), then an async init block calling each `init()` in the original order. Target ≤ ~150 LOC. Confirm no stray top-level state/functions remain (grep for `^function `, `^let `, `^const ` that aren't controller instances).

- [ ] **Step 2:** Verify build + types: `npm run typecheck`, `npm run lint`, `npm run build --workspace apps/scene-editor` is **not** needed; instead `npm run build --workspace apps/avatar-live` if such a script exists (else `npx vite build` in the app dir). Expected: clean build.

- [ ] **Step 3: Manual smoke test** — `npm run dev:avatar`, open http://localhost:5175, and verify (all must behave exactly as before):
  1. avatars discovered in dropdown; switch between them; load a `.glb` by file and by URL;
  2. type a script → **Speak (stream)** → audio + lip-sync + gestures; **Stop** works;
  3. lip-sync calibration sliders move the mouth; **Save to avatar** persists;
  4. **Record** → downloadable clip; capture-format switch works;
  5. **Timeline** toggle; preview; add a camera cue + audio cue; edit in cue inspector; delete cue;
  6. transform: align-to-face, gizmo move/rotate, reset camera/avatar;
  7. lighting presets + studio toggle + idle motion;
  8. back-screen: load a video, cast, **Back to headline**;
  9. **Save** a project → reload page → **Load** it (state restored); **load the bundled sample**.
  - The busy-guard: while speaking/recording/previewing, avatar switch + preview start are blocked (same as before).

- [ ] **Step 4: Commit** — `git commit -am "refactor(avatar-live): collapse main.ts to wiring layer"`

- [ ] **Step 5: Push** — `git push origin main`.

---

## Self-review notes (spec coverage)
- §3.1 StudioContext → Task 1. §3.2 controllers → Tasks 2-10 (one each). §3.3 single-owner state, busy guard, decentralized serialize/apply, dep order → Tasks 7-11. §3.4 file layout → matches. §4 migration order → Tasks 1-11 in the specified order. §5 verification → per-task typecheck/lint + Task 11 smoke test. §6 risks (`this` binding → arrow members; persistence shape → Task 10 critical note; init timing → Task 11 preserves order).
- The one judgment call flagged inline: `setSpeakingUi` ownership (Task 8 note) — resolve by owning it in `Performer` and giving `TimelineEditor` a private preview-button updater; verify against the current code which buttons each toggles.
