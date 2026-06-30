# Camera Shot-Preset Catalog — design

**Status:** approved (brainstorm 2026-06-29) · **Supersedes nothing** · extends the
Score/Stage direction (`2026-06-25-performance-score-dsl-design.md`).

## Problem

The studio has **two** independent camera-framing systems and a fixed vocabulary of
three live shots:

- The live `#shot` dropdown (`close` / `medium` / `wide`) → `stage.frame()`, with
  hardcoded `factor` / `drop` constants and a fixed fov, single-subject head-on only.
- The timeline / newscast cue presets → `timeline/catalog.ts:poseFor()` →
  `@las/performer-core composeShot` (`cam.close` / `cam.anchor` / `cam.wide`) plus three
  hand-offset "angled" framings (`cam.screen` / `cam.enterLeft` / `cam.orbit`) that the
  size model can't express.

Adding a new framing today means editing engine code in one or both systems. We want
**direction as data**: a single catalog of named shot presets — each a row of spatial
parameters — that feeds BOTH the live dropdown AND newscast cue authoring, computed by
ONE interpreter.

## Goals

- ≥ 5 new cinematic shot presets (plus a slow push-in **move**), defined as DATA.
- One shared catalog → live `#shot` dropdown AND newscast cam cues.
- Subject-relative (survives the anchor walking / a different avatar's head height),
  with follow + a time-based push-in.
- Preserve today's look: existing `composeShot` parity fixtures must still pass; the
  orbit/roll extensions are identity at their defaults.

## Non-goals

- No change to the 7-element `PoseTuple` / `cam.custom` explicit-pose path (kept as the
  bespoke escape hatch). Roll reaches the newscast via the new `cam.preset` cue, not via
  tuples.
- No new lighting / set-geometry layouts (separate concern).

## The catalog

The fixed set is the existing studio: the anchor stands at the origin facing **+Z**
(toward the camera); the video wall / screen sits to the anchor's **right** at
`SCREEN_STAND_POS = (1.95, 1.62, −0.35)`. Each preset is *where the camera sits + how
tight*, resolved against the live subjects.

| id | subject | size (heads / fit) | azimuth° | elev° | fov | roll° | follow | move |
|----|---------|-----|-----|-----|-----|------|--------|------|
| `close` | anchor | 4.0 | 0 | 0 | 30 | 0 | – | – |
| `medium` *(default)* | anchor | 5.2 | 0 | 0 | 32 | 0 | – | – |
| `wide` | anchor | 9.0 | 0 | 0 | 40 | 0 | – | – |
| `two-shot` | both | fit | 0 | 0 | 40 | 0 | ✓ | – |
| `ots-screen` | screen | 4.5 | 155 | −2 | 38 | 0 | – | – |
| `profile` | anchor | 5.0 | 40 | 0 | 34 | 0 | – | – |
| `hero-low` | anchor | 6.0 | 0 | −12 | 30 | 0 | – | – |
| `dutch` | anchor | 5.0 | 8 | 0 | 36 | 6 | – | – |
| `establish` | both | fit-wide | 25 | 18 | 28 | 0 | – | – |
| `push-in` | anchor | 7.0 → 4.2 | 0 | 0 | 32 | 0 | – | ✓ ~3 s |

`close` / `medium` / `wide` unify on the `composeShot` numbers (one source of truth), so
the live framing shifts *slightly* to match the cue presets and retires the
"two distinct camera systems" wart in `stage.ts`. Angle/size numbers are starting points,
tuned during implementation against real preview renders.

## Architecture

```
@las/performer-core (pure math + data) ── single source of truth
  types.ts        Composition += azimuth/elevation/roll, size: ShotSize|number
                  Pose       += roll?
  composeShot.ts  base pose → orbit offset around target by azimuth(Y)+elevation(right),
                  copy roll; numeric size synthesizes a SizeSpec
  sampleShot.ts   sampleShot(composition, subjects, tSec) — moves: push-in lerps numeric
                  size by ease(t/dur); follow = recompute from live subjects each call
  cameraShots.ts  CAMERA_SHOTS: Record<id, {subject, composition, move?, label}>,
                  CAMERA_SHOT_IDS
        │
        ├── @las/protocol (DSL vocab + compilers)
        │     re-exports CAMERA_SHOT_IDS as the DSL enum
        │     score.ts        CameraDirective |= { preset: enum }
        │     newsreport.ts   CameraCue.preset?: enum
        │     scoreCompile    preset → composeShot keyframe vs stage subjects;
        │                     push-in → from/to keyframes over durationSec
        │     newsreportCompile  preset → `cam.preset` cue carrying the id
        │
        └── apps/avatar-live (studio)
              timeline/catalog.ts  poseFor() resolves catalog ids (single + two-subject,
                                   importing SCREEN_STAND_POS); CATALOG gains the new
                                   entries (Add-menu + dropdown); CameraPose += roll
              scene/stage.ts       setCameraPose(+roll); applyShotPreset(id) resolves live
                                   subjects → sampleShot → setCameraPose; active-shot
                                   per-frame driver for follow / push-in
              #shot dropdown       populated from CAMERA_SHOT_IDS; change → applyShotPreset
              cue applier          reads CameraPose.roll, applies on the playback path
```

### Interpreter (composeShot extension)

After computing today's base pose, orbit the camera **offset vector** around the look
target: `azimuth` about world-Y, then `elevation` about the view's right-axis; copy
`roll` onto the `Pose`. With `azimuth = elevation = roll = 0` the orbit is identity →
today's output is byte-for-byte preserved (guarded by the existing CAMERA_* fixtures).
Two-subject shots orbit the same way around the fit-midpoint. Numeric `size` synthesizes a
`SizeSpec` (`distHeads = size`, proportional target-drop tuned to keep the face in the
upper third).

### Moves + follow

`sampleShot(composition, subjects, tSec, out?) → Pose`:
- static → ignores `t`, one `composeShot`;
- `push-in` → lerp numeric size `from → to` by `ease(t / dur)`, `composeShot`;
- `follow` → recompute from live subjects every call; the flag tells the studio to keep
  re-sampling per-frame (vs. set-once then let OrbitControls hold).

### Roll (dutch)

A `lookAt` pose can't express a canted horizon, so `Pose.roll` (degrees, default 0) is
added and carried through `CameraPose`. `stage.setCameraPose` applies it as a view-axis
tilt after `lookAt`. Roll reaches the newscast only through the `cam.preset` cue
(runtime-resolved via `poseFor`), never through the 7-element tuple.

## Testing (vitest, no CI)

- **performer-core**: orbit (azimuth 90 → camera on the side, distance to target
  preserved), elevation up/down, `roll → Pose.roll`, numeric-size monotonicity, push-in
  endpoints + midpoint; **existing CAMERA_* parity fixtures must still pass** (identity at
  defaults).
- **protocol**: all 10 ids resolve to valid `Composition`s; schema enum includes them; the
  compiler emits one keyframe per static cam-cue and a from/to pair for push-in.
- **studio smoke**: pick each shot in the dropdown and render a preview frame to tune
  angles; author a newscast referencing ids and export.

## Files touched

- `packages/performer-core/src/{types,composeShot}.ts`, new `sampleShot.ts`,
  `cameraShots.ts`, `index.ts`; tests.
- `packages/protocol/src/{score,newsreport,scoreCompile,newsreportCompile,index}.ts`;
  tests; `npm run protocol:schema`.
- `apps/avatar-live/src/timeline/catalog.ts`, `scene/stage.ts`, the `#shot` wiring
  (`app/avatarTransform.ts` + `index.html`), and the cue-applier roll thread.

## Risks

- **Parity drift** — the orbit/numeric extensions must be identity at defaults; pinned by
  the CAMERA_* fixtures and a fresh "az/el/roll = 0 ≡ today" test.
- **Two-subject orbit** — orbiting a fit-framed two-shot can push the screen out of frame;
  `establish`/`two-shot` angles are conservative and tuned against renders.
- **Roll thread** — additive optional field; defaulting 0 keeps every existing path
  unchanged.
