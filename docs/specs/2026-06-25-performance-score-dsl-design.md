# Performance Score DSL — design

**Status:** draft for review · **Date:** 2026-06-25 · **Scope:** cross-plane (avatar-live, engine-three, 2D/realtime)

## 1. Why this exists (root cause)

Every creative requirement this session — walk to the screen, point with the correct
arm, present palm-up, a two-shot that follows, cross from left of the screen to the right,
enter, a closing gesture, "make the camera look exactly like this" — required a **code
change**. That is not bad luck; it is the direct consequence of three structural facts,
confirmed by mapping the codebase:

1. **The vocabulary is enumerated, not parameterized.** `packages/protocol/src/dsl.ts`
   header literally says *"intentionally flat and enumerated."* `GESTURES`, `CAMERA_SHOTS`,
   `CAMERA_MOVES`, `CAMERA_TARGETS`, `POSTURES` are fixed lists. Anything outside a list has
   nowhere to live but new code. The manifest even *collapses* 10 gestures → 3 montages.
2. **There is no spatial model in the performance path.** A spatial model exists only in
   `scene.ts` (the editor scene graph). The DSL → manifest → render path carries no
   positions, marks, paths, or object-targets. So "the screen", "left of screen", "point at
   X", "stand beside Y" cannot be expressed as data → they became `goToScreen()`,
   `goToScreenRight()`, `frameAnchorScreen()`, `poseFor('cam.screen')`.
3. **Two parallel performance engines that diverge.** `engine-three` consumes the manifest
   spatially; `avatar-live` re-implemented its own imperative camera (`frame`, `poseFor`,
   `frameAnchorScreen`), its own gesture map (`gestures.ts`, diverged — it added
   `enter`/`cross_*`), and its own station/IK/finger code with ~20 hardcoded constants.
   Live vs. export, and 3D-browser vs. 3D-engine, drift apart and get patched separately.

**The fix is one idea applied everywhere: replace _enumeration_ with a _parameterized,
spatial, compositional_ score, compiled deterministically and run by _one_ shared
interpreter for every plane.** The director/producer/writer authors a single artifact; the
studio imports it and performs it. Code changes only when a genuinely new *capability* is
added — not for a new creative idea.

## 2. Goals / non-goals

**Goals**
- A single authored artifact (the **Score**) that expresses staging, camera, gesture,
  look-at, emotion, and timing as **data**, referencing named entities in a **Stage**.
- A small, stable set of **primitive verbs** (the only capability surface) + a **camera
  composition grammar** that cover the director's normal vocabulary, so creative work is
  authoring, not coding.
- **One runtime** (shared pure-math library) used by avatar-live (browser) and engine-three
  (node), so live and offline can never diverge again.
- **Back-compatible & LLM-emittable**: existing enums survive as *presets* that compile to
  parameters; the director LLM still emits a mostly-enumerated, named-reference document.

**Non-goals / honest boundary**
- This does **not** make code edits literally never happen. A brand-new *primitive verb*
  ("sit", "hand a prop to a second presenter") or a new *asset* (a new clip, a new avatar)
  is still code/content work. The claim is narrower and real: **everything within the
  performance vocabulary becomes pure authoring.** Every hand-coded behavior from this
  session collapses to a few lines of Score/Stage data (see §11).
- Not redesigning TTS, avatar build, or job/queue schemas (those enums are fine — they are
  capabilities/infra, not creative direction).

## 3. Architecture: four layers, one runtime

```
   Stage (set)            Score (the one authored artifact)
   marks · targets        beats: speech + cues (move/turn/gesture/look/emote/camera)
   props · cameras        references entities by NAME; presets OR parameters
   lights · look                     │
        └──────────────┬─────────────┘
                       ▼
                 compile()  (pure, deterministic; like compileManifest but spatial)
                       ▼
              Performance (resolved, low-level)
   absolute-timed beats · resolved camera keyframes (transforms) · motion paths ·
   gesture params · a 2D-safe projection (per-beat emotion/gesture/posture)
                       ▼
        ┌──────────────┴───────────────────────────┐
        ▼                     ▼                      ▼
  avatar-live (browser)   engine-three (node)   2D / realtime
  shared runtime lib      shared runtime lib    read 2D-safe projection only
  (compose-shot, plan-    (same functions)      (emotion/gesture/posture → prompt/clip)
   path, aim-arm, …)
```

The **shared runtime library** is the heart: pure functions (no Three.js types in their
signatures — plain vectors in/out) that both planes call. This is what makes "one engine"
real and ends the divergence.

## 4. The Stage model (spatial, declared once)

Extends today's `SceneDocument`. A Stage names the things a Score refers to. Declared per
set; reused across many Scores.

```ts
type Vec3 = [number, number, number];
interface Mark   { id: string; pos: Vec3; facing?: number | TargetRef } // a floor position
interface Target { id: string; kind: 'prop'|'anchorBody'|'point'; pos?: Vec3; node?: string } // pointable/lookable/frameable
interface SavedShot { id: string; pose: { pos: Vec3; target: Vec3; fov: number } } // a captured exact camera
interface Stage {
  id: string;
  marks: Mark[];          // 'center', 'left_of_screen', 'right_of_screen', 'enter_left'
  targets: Target[];      // 'screen', 'desk', 'camera', plus avatar body parts (face/chest)
  cameras: CameraNode[];  // existing scene cameras
  lights: LightNode[]; props: PropNode[]; look?: PostProcessingSpec;
  savedShots?: SavedShot[]; // "this is how the camera should look" → reusable data, not code
}
```

So `left_of_screen`, `screen`, and a captured camera pose are **data in the set**, not
constants in `avatarController`/`stage.ts`.

## 5. The Score (the authored artifact)

What the writer/director/producer writes. Stays LLM-emittable: cues use named presets and
named Stage references; parameters are an optional escape hatch.

```ts
interface ScoreBeat {
  text: string;                 // the line (writer)
  emphasis?: string[];
  emotion?: EmotionPreset;      // preset enum → compiles to face params (producer/director)
  cues?: Cue[];                 // staging/camera/business, anchored to this beat (director)
  pauseMsAfter?: number;
}
type Cue =
  | { at?: WordAnchor; move:   { to: Ref; gait?: 'walk'|'stride'; speed?: number } }
  | { at?: WordAnchor; turn:   { to: Ref | number } }
  | { at?: WordAnchor; gesture:{ kind: GestureKind; target?: Ref; hand?: 'auto'|'left'|'right'; count?: number; hold?: number; amount?: number } }
  | { at?: WordAnchor; look:   { at: Ref } }
  | { at?: WordAnchor; camera: CameraDirective };   // see §7
type Ref = string;             // a Stage mark/target id, OR "self.face", OR a savedShot id
interface Score { stage: string; defaults?: {...}; beats: ScoreBeat[]; }
```

`Ref` is the unlock: **any** mark/target/body-part/saved-shot is a first-class reference for
`move`/`turn`/`gesture`/`look`/`camera`. "Point at the screen", "look at camera", "walk to
left_of_screen", "frame self+screen" are all the same handful of verbs with a named target.

## 6. The Performance (resolved, low-level)

`compile(stage, score, audioTimings)` → a fully resolved, absolute-timed structure: it
turns marks/targets into positions, camera directives into keyframed transforms (via the
composition solver), moves into paths, gestures into resolved params, and emits a
**2D-safe projection** (per-beat `{emotion, gesture, posture}`) so the 2D planes keep
working unchanged. This is `PerformanceManifest`, evolved — same role, richer + spatial.

## 7. Camera = composition, not enumeration

One directive type replaces the 6 `CAMERA_SHOTS` × 11 `CAMERA_MOVES` enum *and*
avatar-live's hardcoded `poseFor`/`frameAnchorScreen`:

```ts
type CameraDirective =
  | { frame: { subjects: Ref[]; size?: 'cu'|'mcu'|'medium'|'wide'; height?: number; balance?: number; lens?: number }; follow?: boolean }
  | { shot: string /* SavedShot id */ }                 // exact captured pose, reusable
  | { move: 'dolly'|'orbit'|'pan'|'truck'|'pedestal'; amount: number; ease?: Ease };
```

A **composition solver** (pure fn) computes the camera transform that frames `subjects[]`
with the requested size/balance for their *current* positions; `follow:true` recomputes
per-frame. Then:
- "two-shot, anchor + screen, following" = `{ frame: { subjects: ['self','screen'], balance: -0.3 }, follow: true }`.
- "close on the face" = `{ frame: { subjects: ['self.face'], size: 'cu' } }`.
- "the exact look I dialed in" = `{ shot: 'my_two_shot' }` (a SavedShot in the Stage).

No new code for new shots — only new data.

## 8. Primitive verbs = the capability contract

The complete, stable set the runtime implements (the *only* place code changes for new
ability). Each is generic + parameterized:

| Verb | Params | Replaces today's |
|---|---|---|
| `move(to, gait, speed)` | any Ref/point | `goToScreen`, `goToScreenRight`, `enter`, station consts |
| `turn(to)` | Ref/angle | `setTurn`, `motion.turnScreen`, `cross_*` facing |
| `gesture(kind, target?, hand?, count?, hold?, amount?)` | target-aimed | `point`(arm-aim), `count`(finger IK), `cross_*`, the GESTURE_CLIPS map + keyword inference |
| `look(at)` | Ref | gaze target |
| `emote(emotion, intensity)` | preset+param | `setEmotion`, EMOTION_TO_A2F |
| `camera(directive)` | §7 | `frame`, `poseFor`, `frameAnchorScreen`, CAMERA_SHOTS/MOVES |

`gesture.kind` stays a named library (wave/point/present/count/clasp/nod/openPalms…) for
LLM-friendliness, but is parameterized by `target`/`hand`/`amount` so one `point` covers
every direction and target without code. Arm-side auto-selects from the target's side
(the thing we hand-fixed for the screen-on-the-left).

## 9. The shared runtime library

A framework-agnostic package (e.g. `@las/performer-core`) of pure functions consumed by
both browser and node:
`composeShot(subjects, composition) → {pos,target,fov}` · `planPath(from,to) → samples` ·
`aimLimb(skeleton, side, targetDir) → quats` · `resolveGesture(kind, params) → drive` ·
`fingerCount(n, t) → curls`. avatar-live and engine-three become **thin adapters** (load
clips, set bone quats, set the camera) over this library. `avatar-live/gestures.ts`,
`stage.ts`'s camera methods, and `avatarController`'s station/IK code are deleted in favor
of it.

## 10. Per-plane consumption (degradation is free)

| Field | engine-three 3D | avatar-live 3D | 2D EchoMimic | realtime MuseTalk |
|---|---|---|---|---|
| camera directives / spatial | ✓ | ✓ | ignored | ignored |
| move/turn/gesture(target)/look | ✓ | ✓ | — | — |
| 2D-safe `{emotion,gesture,posture}` | ✓ | ✓ | → prompt | → clip select |
| text/audio/emphasis/emotion | ✓ | ✓ | ✓ | ✓ |

This mirrors today exactly: 2D paths already only read emotion/gesture/posture. The
Performance keeps that projection, so they need **no** change.

## 11. What this session's code becomes (the proof)

| Hand-coded this session | After: pure data |
|---|---|
| `goToScreen`/`goToScreenRight`/`enter` + station consts | Stage marks + `move:{to:'left_of_screen'}` cues |
| left-arm point, no chest-crossing | `gesture:{kind:'point', target:'screen'}` (hand auto = target side) |
| palm-up present, distributed roll | `gesture:{kind:'present', target:'screen'}` (a library kind) |
| finger-count IK | `gesture:{kind:'count', count:3}` |
| `frameAnchorScreen` two-shot + follow | `camera:{frame:{subjects:['self','screen']},follow:true}` |
| "match the camera I set" tuning constants | `camera:{shot:'my_two_shot'}` (SavedShot) |
| calm + enter/cross/close choreography | a 6-beat Score with 3 cues; no code |

## 12. Migration (phased, additive, back-compatible)

1. **Stage + Score + Performance schemas** in `packages/protocol` (additive; old `Script`/
   `NewsReportDoc` keep working — enums become presets that compile to params).
2. **`@las/performer-core`**: the pure runtime lib (composition solver, path, aim, gesture).
   Unit-tested in isolation.
3. **avatar-live adopts it**: replace `gestures.ts` + `stage.ts` camera + `avatarController`
   stations/IK with adapters over the lib. Delete the parallel system. Live + export share
   one path (kills the export-camera divergence permanently).
4. **engine-three adopts it**: replace `SHOT_PARAMS`/`moveDelta`/montage map with the lib.
5. **Authoring/Compile**: `compile(stage, score)` → Performance/manifest; bridge
   `applyNewscast` + the director LLM emit Scores; old NewsReport compiles to a Score.
6. **2D**: unchanged — read the 2D-safe projection.

Each phase is shippable and reversible.

## 13. Risks / open questions

- **LLM emittability of a richer schema.** Mitigation: the Score stays preset+named-ref
  heavy; parameters are optional. Need to validate the director prompt still emits clean
  Scores (a test corpus).
- **One runtime, two engines (browser vs node Three).** Keep the lib framework-agnostic
  (plain numbers in/out); adapters own the Three objects. Risk: subtle numeric drift —
  covered by shared golden tests.
- **Scope of the cut-over.** avatar-live has a lot of imperative code; the migration is
  real work. Phasing (per §12) keeps it safe.
- **Open:** exact `gesture.kind` library list; the composition solver's balance/size model;
  whether SavedShots live in the Stage or a separate "shot library".
```
