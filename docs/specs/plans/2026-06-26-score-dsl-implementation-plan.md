All issues are now verified against ground truth. The clip filenames are confirmed `snake_case` (`open_palms`, `hand_to_chest`, `thumbs_up`), `GESTURE_CLIP_PRESET` must map camelCase Score kinds to these. The avatar-live `Gesture` enum mixes clip-gestures and stage-moves (`enter`/`cross_left`/`cross_right`). `scheduleAudioCues` is in `timelineEditor.ts:129`, `renderMixdown` in `offlineAudio.ts`.

I have everything I need to write the corrected plan addressing all 30 issues. Writing it now.

# Implementation Plan — Performance Score DSL (Score/Stage) for the avatar-live Studio

## Goal

Replace the avatar-live studio's enumerated, hand-coded performance vocabulary (camera `poseFor`/`frameAnchorScreen`, the gesture clip map, the station/IK machine, and the split live/export drive paths) with a **parameterized, spatial, compositional Score**, compiled deterministically to a low-level **Performance** and run by **one** shared drive path. Per the design spec (`docs/specs/2026-06-25-performance-score-dsl-design.md`), creative work becomes *authoring data* (a `Score` + a `Stage`), and code changes only when a genuinely new primitive verb or asset is added.

The durable fix is a **single pure-math runtime** (`@las/performer-core`) that both planes call, proven correct in isolation with **golden + regression fixtures pinned to today's exact numbers** *before* any avatar-live call site is swapped. That converts the risky cut-over into a provably behavior-preserving swap at two integration points (`player.resolvePose`, and a new `score.drive`).

**Reality check that shapes this plan:** `engine-three` has already been removed from the workspace (root `package.json` workspaces = `packages/*`, `services/control-api`, `services/newsroom-mcp`, `apps/avatar-live`; `scene.ts`/`manifest.ts`/`EngineRenderSpec` are gone). So the only 3D adapter to cut over is **avatar-live**, which is **100% three.js**.

**Single-engine consequence — the plain-vector boundary is a deliberate, scoped trade, not free insurance.** With one consumer, `performer-core`'s "plain tuples in/out, no three.js" rule has a real per-frame cost: a `coreAdapter` layer converting `THREE.Vector3 ↔ Vec3`, and quaternion tuples (`[x,y,z,w]`) rebuilt into `THREE.Quaternion`. The existing motion code is meticulously allocation-free (`avatarController.ts:32–50` module-scope scratch `Vector3`/`Quaternion`/`Matrix4` reused every frame; `stage.ts:5` `_afCam`/`_afTgt`). We keep `performer-core` framework-agnostic **only because**: (a) it makes the math unit-testable with golden numeric fixtures (the entire correctness story), and (b) it keeps the door open for a future engine-three re-adopting the identical fixtures. We pay for (a)+(b) with a **mandatory out-param adapter discipline** (see Phase 4a Task 1a and the cross-cutting "Allocation budget" rule) so the per-frame path does **not** regress to per-frame GC churn. This cost is acknowledged and explicitly bounded; it is not hand-waved as "cheap."

Because `SceneDocument`/`PerformanceManifest` no longer exist in protocol, `Stage` **standalone-reintroduces** the spatial model (Vec3/Mark/Target/SavedShot/CameraNode/LightNode/PropNode), and `Performance` is a **fresh** schema, not an edit.

## Architecture

```
packages/performer-core   (NEW, pure math, zero deps, NO three.js, NO zod)
  composeShot · planPath · aimLimb · resolveGesture · fingerCount · aimEye · turnToward · moveCamera   ← the divergence-ending seam
        ▲                                   ▲
        │ (compile-time solving)            │ (per-frame solving)
        │                                   │
packages/protocol         (EXISTING, +stage/score/performance/scoreCompile/presets)
  Stage·Score·Performance zod contracts
  compileScore(stage, score, audioTimings, body) -> Performance   ← like compileNewsReport but spatial
  compileNewsReportToScore(doc) -> Score                          ← back-compat bridge
        ▲
        │ import @las/protocol   (depends on @las/performer-core at compile time)
        │
apps/avatar-live          (EXISTING, becomes a THIN ADAPTER)
  scene/stage.ts camera methods        -> composeShot / moveCamera
  avatar/avatarController.ts IK/station -> planPath/aimLimb/fingerCount/aimEye/turnToward
  avatar/gestures.ts clip map          -> resolveGesture (RENAMED; old parser → parseScriptLine)
  app/performer.ts driveAvatarFrame    -> ONE score.drive(t,dt,mouth) for live + export (incl. screen + audio channels)
        ▲
        │ (Studio Bridge WS — unchanged envelope)
services/newsroom-mcp     (EXISTING, +WebMCP v1 server wrapping bridge handlers — late, parallel)
services/control-api + protocol/{bridge,director,jobs}  (touched last; bridge/director emit Scores)
```

**Data flow:** author `Score` + `Stage` → `compileScore()` (pure) → `Performance` (absolute-timed beats, resolved camera keyframes incl. follow + relative moves, motion paths with arrival facing, resolved turns, gesture params, looks, **screen-cut channel**, **audio channel**, **2D-safe `{emotion,gesture,posture}` projection**) → `score.drive(t,dt,mouth)` consumed identically by the live tick and the offline export. Adapters own all Three.js objects and translate to/from plain number tuples **via reused out-params**.

**Avatar-relative refs (`self.*`) are runtime-resolved, not compile-time baked.** The compiler cannot know a loaded GLB's head position (`avatarController.headCenter`/`headHeight` are recomputed in `fitAvatar` after every load, `avatarController.ts:235–236`). So `Performance` carries `self.*` targets as a **late-bound `BodyRef` marker** (`{bind:'face'|'chest'|'root'}`), and `score.drive` re-resolves them per-frame against the live avatar — exactly how gaze (`setGazeTarget`) and the two-shot (`group.position`) track the avatar dynamically today. See Phase 1 (`performance.ts` `ResolvedTargetRef`), Phase 3 Task 2 (compiler emits the marker), Phase 4c Task 1a (runtime resolves it).

## Tech Stack

- **TypeScript, npm workspaces, Node ≥20** (existing). `tsconfig.base.json` sets `strict`, **`noUncheckedIndexedAccess: true`**, **`verbatimModuleSyntax: true`**, **`isolatedModules: true`**, `moduleResolution: "Bundler"`. **Every** code sketch in this plan must satisfy these (see the cross-cutting "tsconfig discipline" rule).
- **`@las/performer-core`** — new workspace package under `packages/`. `type: module`, `tsc` build, **vitest** test config, **zero runtime deps** (explicitly no `three`, no `zod`). Plain `number[]`/tuples in and out; per-frame fns also accept **out-params** to avoid allocation.
- **`@las/protocol`** — existing; **zod** contracts + JSON-Schema gen via `zod-to-json-schema` (`scripts/gen-schema.ts`, run with `tsx`). Stays three.js-free; depends on `@las/performer-core` only for compile-time solving inside `scoreCompile.ts`.
- **`@las/avatar-live`** — existing; **three 0.152.2** + Vite (port 5175). Becomes a thin adapter; **adds `@las/performer-core` AND `@las/protocol` as explicit deps** (today it consumes `@las/protocol` only via root workspace hoisting — `apps/avatar-live/package.json` deps = `three`/`postprocessing`/`mediabunny` only; there is **no `@las` Vite alias**, so both packages resolve through `node_modules/@las/*` `main → dist/`).
- **`services/newsroom-mcp`** — existing MCP server (`@modelcontextprotocol/sdk`, `registerTool` + `TOOL_MODULES` registry); gains a WebMCP v1 surface wrapping existing bridge handlers.
- **Verification (no CI):** protocol = `npm test --workspace @las/protocol` (vitest) + `npm run protocol:schema`; performer-core = `npm test --workspace @las/performer-core` (golden/regression fixtures); avatar-live = `tsc --noEmit` + `vite build` + the **headless scoreDrive parity vitest** (Phase 4c) + manual browser smoke; root `npm run typecheck` + `npm run lint` before each ship.
- **Branch policy:** push-to-`main` is blocked. Every phase = a **feature branch → PR → merge**. Each phase is independently shippable (studio builds + smokes green) and independently revertible — **with one explicit exception documented under "Shippability caveat" in Phases 4a/4b**: between 4a-merge and 4c-merge the live-vs-export camera divergence is *bounded and known*, not eliminated; 4a/4b are shippable as *no-regression refactors*, and the divergence is *closed* only at 4c.

### Cross-cutting rule A — performer-core build ordering (build-graph hazard, highest severity)

`@las/performer-core` has `main: ./dist/index.js` and `dist/` is **gitignored** (`.gitignore` lines 27–28: `dist/`, `**/dist/`). Consumers (`@las/protocol` from Phase 3, `@las/avatar-live` from Phase 4a) resolve it through `node_modules/@las/performer-core/dist/`, **not** a src alias. Therefore **a stale or missing `performer-core/dist` silently ships old math, and a fresh clone fails to typecheck/build until dist exists.** Mandatory mitigations, applied in every phase that consumes it:

1. **`@las/protocol` `build` and `typecheck` scripts gain a prebuild:** change `packages/protocol/package.json` to `"build": "npm run build --workspace @las/performer-core && tsc -p tsconfig.json"` and `"typecheck": "npm run build --workspace @las/performer-core && tsc -p tsconfig.json --noEmit"`. (Building the dependency, not just typechecking it, because protocol's runtime `compileScore` imports performer-core's compiled JS.)
2. **`@las/avatar-live` `build`/`typecheck` scripts gain the same prebuild:** `"build": "npm run build --workspace @las/performer-core && vite build"`, `"typecheck": "npm run build --workspace @las/performer-core && tsc --noEmit"`.
3. **Root `npm run typecheck`/`build` already iterate workspaces** (`--workspaces --if-present`); npm runs them in dependency-topo order, but because the scripts above self-prebuild performer-core, ordering is correct even when a single workspace is typechecked in isolation.
4. **Each phase's acceptance gate explicitly lists `npm run build --workspace @las/performer-core` as step 0** before the consumer's `tsc --noEmit`/`vite build`.
5. **README/CLAUDE note (Phase 0 Task 9):** "after pulling, run `npm install && npm run build --workspace @las/performer-core` — its dist is gitignored." A `prepare` script (`"prepare": "tsc -p tsconfig.json"`) in performer-core's package.json also rebuilds dist on `npm install`, covering the fresh-clone case.

### Cross-cutting rule B — tsconfig discipline (applies to every sketch below)

`noUncheckedIndexedAccess` makes **every** `arr[i]`, `obj[key]`, `path[i+1]`, `timings.beats[i].words[anchor.word]`, `BUCKETS[ENERGY[emotion]]` yield `T | undefined`. `verbatimModuleSyntax` + `isolatedModules` require `import type`/`export type` for all type-only symbols, and forbid value-importing a type. The plan's code sketches are **illustrative shapes, not paste-ready**; every implementer task that indexes an array MUST add an explicit guard or a justified non-null assertion, and the **out-of-range WordAnchor case is a defined error path, not a crash** (Phase 3 Task 3 specifies the guard). Concretely:
- performer-core barrels use `export type { … } from './types.js'` for the type-only symbols and a separate `export { … } from './composeShot.js'` for the value fns — never a blanket `export *` over a types-only module (that emits value re-exports and fails `isolatedModules`).
- In `scoreCompile.ts`, zod **consts** (`Stage`, `Score`, `AudioTimings`) are value-imported; their inferred **types** are `import type`. Where a protocol `Vec3` and a performer-core `Vec3` are both in scope, **alias** one: `import type { Vec3 as CoreVec3 } from '@las/performer-core'`.
- Indexing helpers (`atOr(arr, i, fallback)`, `wordAt(beat, idx)`) are introduced in Phase 3 Task 3 and reused, so the guards live in one place.

### Cross-cutting rule C — allocation budget at the adapter boundary (per-frame regression guard)

The live tick and the 30 fps export call solvers **every frame**. `composeShot(follow:true)`, `aimEye`, `turnToward`, and `fingerCount` are per-frame. To preserve the existing allocation-free design:
- performer-core per-frame fns expose an **out-param overload**: e.g. `composeShot(subjects, comp, out?: Pose): Pose` writes into `out` (reused `{pos,target,fov}` with reused tuples) when provided and returns it; `aimEye(dir, out?: {quat:Quat})`; `fingerCount(n, t, out?: FingerCurls)`. The allocating signature stays for compile-time use (Phase 3) where allocation is irrelevant.
- `coreAdapter.ts` (Phase 4a) holds **module-scope reusable** `Pose`/`Vec3`/`Quat` scratch and `THREE.Vector3`/`THREE.Quaternion` scratch, and writes solver output into them every frame — mirroring `avatarController.ts:32–50`. No `new` in the per-frame path.
- A perf assertion is added to the parity harness (Phase 4c Task 6): drive 300 frames and assert via a wrapped allocation counter (or a `performance.measureUserAgentSpecificMemory`-free heap-delta sampling in node vitest) that steady-state per-frame allocation is below a small threshold. This is coarse but pins "no per-frame churn introduced" as a *test*, not a hope.

---

## Phase 0 — `@las/performer-core` skeleton + golden test harness

**Goal:** Stand up the framework-agnostic package with the **eight** pure-fn signatures (typed, stubbed) and a vitest harness, so all later math lands against a real test surface. No protocol or avatar-live changes.

**Shippable / acceptance:** `npm install` resolves the new workspace and (via `prepare`) builds its dist; `npm run typecheck` (root) and `npm test --workspace @las/performer-core` both pass (stubs + one trivial golden test green); `npm run build --workspace @las/performer-core` emits with `tsc`.

### Files to Create
- `packages/performer-core/package.json`
- `packages/performer-core/tsconfig.json`
- `packages/performer-core/vitest.config.ts`
- `packages/performer-core/src/types.ts`
- `packages/performer-core/src/index.ts`
- `packages/performer-core/src/composeShot.ts`, `moveCamera.ts`, `planPath.ts`, `turnToward.ts`, `aimLimb.ts`, `aimEye.ts`, `resolveGesture.ts`, `fingerCount.ts`
- `packages/performer-core/src/composeShot.test.ts` (smoke golden)

### Files to Modify
- `package.json` (root) — `packages/*` already globs the new package; **verify** `npm install` links it (no edit expected). `npm test`/`typecheck` use `--workspaces --if-present`, which auto-includes it.

### Tasks
1. Create `packages/performer-core/package.json`:
   ```json
   {
     "name": "@las/performer-core",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
     "scripts": {
       "build": "tsc -p tsconfig.json",
       "typecheck": "tsc -p tsconfig.json --noEmit",
       "test": "vitest run",
       "prepare": "tsc -p tsconfig.json"
     },
     "devDependencies": { "typescript": "^5.6.2", "vitest": "^2.1.2" }
   }
   ```
   (No `dependencies` — zero runtime deps is a hard requirement. `prepare` builds dist on `npm install` so a fresh clone is never missing it — Cross-cutting rule A.)
2. Create `tsconfig.json` extending `../../tsconfig.base.json` (so `noUncheckedIndexedAccess`/`verbatimModuleSyntax`/`isolatedModules` apply identically) with `outDir: dist`, `rootDir: src`, `declaration: true`.
3. Create `vitest.config.ts` (`test: { include: ['src/**/*.test.ts'] }`).
4. Create `src/types.ts` — the plain-vector contract (NO three.js). **This is the single source of `Vec3`/`Quat`/`ShotSize`/`GestureKind`/`Drive` for the math layer; protocol re-derives compatible zod versions and the boundary contract is stated in Phase 3.**
   ```ts
   export type Vec3 = [number, number, number];
   export type Quat = [number, number, number, number]; // x,y,z,w
   export interface Subject { pos: Vec3; size?: number }  // size = world head-height
   export type ShotSize = 'cu' | 'mcu' | 'medium' | 'wide';
   export interface Composition {
     size?: ShotSize; height?: number; balance?: number; lens?: number; follow?: boolean;
   }
   export type CameraMove = 'dolly' | 'orbit' | 'pan' | 'truck' | 'pedestal';
   export interface Pose { pos: Vec3; target: Vec3; fov: number }
   export interface PathSample { pos: Vec3; t: number } // t = normalized 0..1 along path
   export interface PathPlan {
     samples: PathSample[]; length: number; gait: 'walk' | 'stride'; speed: number;
     arriveFacing?: number; // yaw radians at the destination, when authored (Mark.facing)
   }
   export type Side = 'left' | 'right';
   export interface LimbAim { upperArm: Quat; foreArm: Quat } // parent-space local quats
   export interface EyeAim { quat: Quat }                      // head-local eye aim
   export interface FingerCurls { curls: number[][] } // [finger][joint] radians about local X
   export type GestureKind =
     | 'none' | 'wave' | 'point' | 'present' | 'count' | 'clasp'
     | 'nod' | 'openPalms' | 'thumbsUp' | 'shrug' | 'handToChest' | 'explain';
   export interface GestureParams {
     target?: Vec3; hand?: 'auto' | Side; count?: number; hold?: number; amount?: number; seed?: number;
   }
   export type DriveKind = 'clip' | 'ik' | 'none';
   export type BaseEnergy = 'low' | 'med' | 'high';
   export interface Drive { kind: DriveKind; clip?: string; baseEnergy?: BaseEnergy; ik?: 'aim' | 'count' }
   ```
5. Create the **eight** stub modules, each with the final signature + `throw new Error('not implemented')`. Note the **corrected `aimLimb` signature** (carries the parent's world quaternion so a pure function can reproduce today's parent-space aiming — see the rationale in Phase 2 Task 5), plus the three net-new solvers (`moveCamera`, `turnToward`, `aimEye`) that the spec's primitives require but the original plan omitted:
   ```ts
   // composeShot.ts  (absolute framing; out-param overload for per-frame follow)
   export function composeShot(subjects: Subject[], composition: Composition, out?: Pose): Pose { throw new Error('not implemented'); }
   // moveCamera.ts  (RELATIVE camera ops: dolly/orbit/pan/truck/pedestal applied to a base Pose)
   export function moveCamera(base: Pose, move: CameraMove, amount: number, out?: Pose): Pose { throw new Error('not implemented'); }
   // planPath.ts  (carries arriveFacing resolved from Mark.facing)
   export function planPath(from: Vec3, to: Vec3, opts?: { gait?: 'walk'|'stride'; speed?: number; arriveFacing?: number }): PathPlan { throw new Error('not implemented'); }
   // turnToward.ts  (yaw to face a target point, or pass-through an absolute angle — drives setTurn)
   export function turnToward(from: Vec3, to: Vec3): number { throw new Error('not implemented'); } // returns yaw radians
   // aimLimb.ts  (2-bone arm aim; parentWorldQuat supplied so parent-space local quats are reproducible; side 'auto' from targetDir azimuth)
   export function aimLimb(targetDir: Vec3, parentWorldQuat: Quat, side: Side | 'auto', opts?: { weight?: number; foreArmWeight?: number }): { side: Side; aim: LimbAim } { throw new Error('not implemented'); }
   // aimEye.ts  (head-local eye aim toward a direction; the `look` primitive solver)
   export function aimEye(targetDir: Vec3, opts?: { maxAngle?: number; weight?: number }, out?: EyeAim): EyeAim { throw new Error('not implemented'); }
   // resolveGesture.ts  (pure: seed/param in, no module state; returns Drive incl. baseEnergy)
   export function resolveGesture(kind: GestureKind, params?: GestureParams): Drive { throw new Error('not implemented'); }
   // fingerCount.ts
   export function fingerCount(n: number, t: number, opts?: { phase?: number; curl?: number[] }, out?: FingerCurls): FingerCurls { throw new Error('not implemented'); }
   ```
6. Create `src/index.ts` barrel: `export type { … } from './types.js';` (all the interfaces/type-aliases) and `export { composeShot } from './composeShot.js';` etc. for the eight value fns. **No `export *` over `types.ts`** (Cross-cutting rule B).
7. Create `src/composeShot.test.ts` — one trivial golden that imports the stub and asserts it is a function (kept failing-proof so the harness is proven without pinning math yet). Real math fixtures arrive in Phase 2.
8. Run `npm install` at root; verify the workspace links and `prepare` produced `dist/`. Run `npm run typecheck` + `npm test --workspace @las/performer-core` + `npm run build --workspace @las/performer-core`.
9. Add a one-line note to the project README / `CLAUDE.md` build section: performer-core's `dist/` is gitignored; after pulling run `npm install` (its `prepare` rebuilds dist) — consumers won't typecheck until it exists (Cross-cutting rule A.5).

**Primitive → solver map (spec §8 verbs → performer-core fns):** `move` → `planPath` (+ `arriveFacing`); `turn` → `turnToward`; `gesture` (library) → `resolveGesture`; `gesture` point → `aimLimb`; `gesture` count → `fingerCount`; `look` → `aimEye`; `camera frame` → `composeShot`; `camera move` (dolly/orbit/pan/truck/pedestal) → `moveCamera`; `emote` → no solver (preset lowering only, intensity is a scalar carried through — see Phase 1/3). **Every spec §8 verb now has a named solver or an explicit "no solver needed" note.**

**Commit point:** `feat(performer-core): scaffold framework-agnostic runtime (8 solvers) + vitest harness`.

---

## Phase 1 — Stage / Score / Performance schemas in `@las/protocol` (additive)

**Goal:** Add the zod data contracts + presets so a `Score`+`Stage` can be authored and validated, with old `Script`/`NewsReportDoc` untouched. No compiler yet, no avatar-live changes. **Builds the spec primitives as data:** Stage marks/targets/savedShots with **`Mark.facing`** (§4), the **six-verb** `Cue` union including **`emote`** (§5, §8), the `CameraDirective` composition grammar **including `move`** (§7), `Score.defaults` (§5), and `Performance` channels for camera/motion/gesture/look **plus screen-cut and audio** (so migrating to Scores never loses the back-wall montage or music beds).

**Shippable / acceptance:** `npm test --workspace @las/protocol` green incl. new `stage.test.ts`/`score.test.ts`; `npm run protocol:schema` writes `dist/schema/{Stage,Score,Performance,Cue,CameraDirective}.json` and the existing schemas still emit; `dsl.test.ts`/`newsreport.test.ts`/`bridge.test.ts` still pass. Root `npm run typecheck` green.

### Files to Create
- `packages/protocol/src/stage.ts`
- `packages/protocol/src/score.ts`
- `packages/protocol/src/performance.ts`
- `packages/protocol/src/presets.ts`
- `packages/protocol/src/stage.test.ts`
- `packages/protocol/src/score.test.ts`

### Files to Modify
- `packages/protocol/src/index.ts` — add barrel exports.
- `packages/protocol/scripts/gen-schema.ts` — import + register new schemas.

### Tasks
1. **`src/stage.ts`** — standalone spatial model (`scene.ts` is gone), reusing `PostProcessingSpec` from `newsreport.ts` for `look`. **`Mark.facing` is carried** (number yaw **or** a `TargetRef` to face):
   ```ts
   import { z } from 'zod';
   import { PostProcessingSpec } from './newsreport.js';
   export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
   export type Vec3 = z.infer<typeof Vec3>;
   export const TargetRef = z.string(); // a Target/Mark id (Mark.facing / look may reference one)
   export const Mark = z.object({ id: z.string(), pos: Vec3, facing: z.union([z.number(), TargetRef]).optional() });
   export const Target = z.object({ id: z.string(), kind: z.enum(['prop','anchorBody','point']), pos: Vec3.optional(), node: z.string().optional() });
   export const SavedShot = z.object({ id: z.string(), pose: z.object({ pos: Vec3, target: Vec3, fov: z.number() }) });
   export const CameraNode = z.object({ id: z.string(), pos: Vec3, target: Vec3.optional(), fov: z.number().default(35) });
   export const LightNode = z.object({ id: z.string(), kind: z.enum(['key','fill','rim','ambient']), intensity: z.number(), color: z.number().optional(), pos: Vec3.optional() });
   export const PropNode = z.object({ id: z.string(), node: z.string().optional(), pos: Vec3.optional() });
   export const Stage = z.object({
     id: z.string(),
     marks: z.array(Mark).default([]),
     targets: z.array(Target).default([]),
     cameras: z.array(CameraNode).default([]),
     lights: z.array(LightNode).default([]),
     props: z.array(PropNode).default([]),
     look: PostProcessingSpec.optional(),
     savedShots: z.array(SavedShot).default([]),
   });
   export type Stage = z.infer<typeof Stage>;
   export type Mark = z.infer<typeof Mark>;
   export type Target = z.infer<typeof Target>;
   export type SavedShot = z.infer<typeof SavedShot>;
   export type CameraNode = z.infer<typeof CameraNode>;
   export type LightNode = z.infer<typeof LightNode>;
   export type PropNode = z.infer<typeof PropNode>;
   ```
2. **`src/score.ts`** — the authored artifact. **Six-verb** `Cue` union (move/turn/gesture/look/camera/**emote**), camera grammar **with `move`**, an exported **named `ShotSize`** (so `presets.ts` can `import type { ShotSize }` — the original plan's broken import), and the `audioTimings` contract. **`emote` carries `intensity`** (the spec §8 `emote(emotion, intensity)` with a mid-beat `at` anchor — `avatarController.setEmotion(name, intensity)` at `avatarController.ts:642` already consumes it):
   ```ts
   import { z } from 'zod';
   export const Ref = z.string(); // Stage mark/target id, OR 'self.face'/'self.chest'/'self.root', OR a savedShot id
   export const Ease = z.enum(['linear','ease_in','ease_out','ease_in_out']);
   export const WordAnchor = z.object({ word: z.number().int().min(0) }); // index into the beat's words
   export const ShotSize = z.enum(['cu','mcu','medium','wide']);          // NAMED — presets.ts imports this
   export type ShotSize = z.infer<typeof ShotSize>;
   export const Gait = z.enum(['walk','stride']);
   export const GestureKind = z.enum(['none','wave','point','present','count','clasp','nod','openPalms','thumbsUp','shrug','handToChest','explain']);
   export type GestureKind = z.infer<typeof GestureKind>;
   export const EmotionPreset = z.enum(['neutral','warm','happy','excited','serious','concerned','sad','confident','thoughtful','surprised']);
   export type EmotionPreset = z.infer<typeof EmotionPreset>;
   export const CameraMove = z.enum(['dolly','orbit','pan','truck','pedestal']);
   export const CameraDirective = z.union([
     z.object({ frame: z.object({ subjects: z.array(Ref).min(1), size: ShotSize.optional(), height: z.number().optional(), balance: z.number().optional(), lens: z.number().optional() }), follow: z.boolean().optional() }),
     z.object({ shot: z.string() }),                                       // SavedShot id
     z.object({ move: CameraMove, amount: z.number(), ease: Ease.optional() }), // relative dolly/orbit/pan/truck/pedestal
   ]);
   export const Cue = z.union([
     z.object({ at: WordAnchor.optional(), move:    z.object({ to: Ref, gait: Gait.optional(), speed: z.number().optional() }) }),
     z.object({ at: WordAnchor.optional(), turn:    z.object({ to: z.union([Ref, z.number()]) }) }),
     z.object({ at: WordAnchor.optional(), gesture: z.object({ kind: GestureKind, target: Ref.optional(), hand: z.enum(['auto','left','right']).optional(), count: z.number().optional(), hold: z.number().optional(), amount: z.number().optional() }) }),
     z.object({ at: WordAnchor.optional(), look:    z.object({ at: Ref }) }),
     z.object({ at: WordAnchor.optional(), camera:  CameraDirective }),
     z.object({ at: WordAnchor.optional(), emote:   z.object({ emotion: EmotionPreset, intensity: z.number().min(0).max(1).optional() }) }), // spec §8 emote(emotion, intensity)
   ]);
   export const ScoreBeat = z.object({ text: z.string(), emphasis: z.array(z.string()).optional(), emotion: EmotionPreset.optional(), cues: z.array(Cue).default([]), pauseMsAfter: z.number().optional() });
   export const ScoreDefaults = z.object({ emotion: EmotionPreset.optional(), gait: Gait.optional(), camera: CameraDirective.optional() });
   export const Score = z.object({ stage: z.string(), defaults: ScoreDefaults.optional(), beats: z.array(ScoreBeat).min(1) });
   export type Score = z.infer<typeof Score>;
   export type Cue = z.infer<typeof Cue>;
   export type CameraDirective = z.infer<typeof CameraDirective>;
   export type ScoreBeat = z.infer<typeof ScoreBeat>;
   export type Ref = z.infer<typeof Ref>;
   export type WordAnchor = z.infer<typeof WordAnchor>;
   // audioTimings: the per-word timing the compiler consumes (minimal, settled here)
   export const WordTiming = z.object({ word: z.string(), startSec: z.number(), endSec: z.number() });
   export const BeatTiming = z.object({ startSec: z.number(), endSec: z.number(), words: z.array(WordTiming).default([]) });
   export const AudioTimings = z.object({ beats: z.array(BeatTiming) });
   export type AudioTimings = z.infer<typeof AudioTimings>;
   export function validateScore(input: unknown): Score { return Score.parse(input); }
   ```
3. **`src/performance.ts`** — the resolved, low-level output type (fresh schema; `PerformanceManifest` is gone). **REUSES `Posture` from `dsl.ts`** (do NOT redefine — `dsl.ts:47` already exports `Posture` from `POSTURES = neutral/leaning_in/upright/relaxed/turned_slightly`; a second `export const Posture` here would collide under two star-exports and make `import { Posture } from '@las/protocol'` ambiguous). Adds **resolved turns**, **a screen-cut channel**, **an audio channel**, a **late-bound `BodyRef`** for `self.*`, **`emote` intensity on the projection**, and **`baseEnergy` on `ResolvedGesture.drive`** (so the determinism fix survives serialization — the original plan dropped it):
   ```ts
   import { z } from 'zod';
   import { Vec3 } from './stage.js';
   import { GestureKind, EmotionPreset } from './score.js';
   import { Posture } from './dsl.js';            // REUSE — do not redefine
   import { AudioCue } from './newsreport.js';     // REUSE the existing audio-cue schema
   // Late-bound avatar-relative target: resolved per-frame by score.drive against the live GLB.
   export const BodyRef = z.object({ bind: z.enum(['face','chest','root']) });
   export const ResolvedTargetRef = z.union([
     z.object({ pos: Vec3 }),     // static world point (resolved at compile time)
     BodyRef,                     // tracks the loaded/walked avatar (resolved at runtime)
   ]);
   export const CameraKeyframe = z.object({
     tSec: z.number(), pos: Vec3, target: Vec3, fov: z.number(),
     follow: z.boolean().default(false),                 // authored snap-follow (the live/export divergence, made explicit)
     followSubjects: z.array(ResolvedTargetRef).optional(),// when follow: re-frame these per-frame (self.* tracks avatar)
     ease: z.enum(['linear','ease_in','ease_out','ease_in_out']).optional(),
     move: z.enum(['dolly','orbit','pan','truck','pedestal']).optional(), // present for relative-move keyframes
     moveAmount: z.number().optional(),
   });
   export const MotionPath = z.object({ startSec: z.number(), endSec: z.number(), from: Vec3, to: Vec3, gait: z.enum(['walk','stride']), speed: z.number(), arriveFacing: z.number().optional() });
   export const ResolvedTurn = z.object({ tSec: z.number(), yaw: z.number() });   // turn verb → setTurn(yaw)
   export const ResolvedGesture = z.object({
     tSec: z.number(), kind: GestureKind,
     drive: z.object({ kind: z.enum(['clip','ik','none']), clip: z.string().optional(), ik: z.enum(['aim','count']).optional(), baseEnergy: z.enum(['low','med','high']).optional() }), // baseEnergy carried
     target: ResolvedTargetRef.optional(), side: z.enum(['left','right']).optional(), count: z.number().optional(), hold: z.number().optional(),
   });
   export const ResolvedLook = z.object({ tSec: z.number(), target: ResolvedTargetRef }); // self.* looks track the avatar
   export const ResolvedEmote = z.object({ tSec: z.number(), emotion: EmotionPreset, intensity: z.number().default(1) });
   export const ScreenCut = z.object({ tSec: z.number(), source: z.string() });  // back-wall vision-mixer cut (today's cam.screenSource)
   // The 2D-safe per-beat projection (what EchoMimic / MuseTalk read), now carrying emote intensity:
   export const BeatProjection = z.object({ startSec: z.number(), endSec: z.number(), text: z.string(), emotion: EmotionPreset, intensity: z.number().default(1), gesture: GestureKind, posture: Posture });
   export const Performance = z.object({
     stageId: z.string(),
     durationSec: z.number(),
     beats: z.array(BeatProjection),                 // absolute-timed + 2D-safe projection
     camera: z.array(CameraKeyframe),
     motion: z.array(MotionPath),
     turns: z.array(ResolvedTurn),                   // resolved turn verbs
     gestures: z.array(ResolvedGesture),
     looks: z.array(ResolvedLook),
     emotes: z.array(ResolvedEmote),                 // mid-beat emote anchors
     screen: z.array(ScreenCut),                     // back-wall montage channel (montage sync preserved)
     audio: z.array(AudioCue),                       // music beds / SFX (mixdown preserved)
   });
   export type Performance = z.infer<typeof Performance>;
   ```
4. **`src/presets.ts`** — preset → param tables lowering the surviving `dsl.ts` enums. **Imports the named `ShotSize`** from `score.ts` (now exported). **The gesture-clip table is the camelCase→snake_case integration seam and is keyed by the camelCase `GestureKind` enum, mapping to the on-disk snake_case clip filenames** (verified loaded clips: `open_palms`, `hand_to_chest`, `thumbs_up`, `point`, `count`, `wave`, `shrug`, `nod`, `idle_calm`, `talk1`). A companion **`GESTURE_KIND_TO_CLIP` is the *single* authority** for this casing translation; avatar-live's `gestureClipFor` (Phase 4b) defers to it, so the two vocabularies never diverge again:
   ```ts
   import type { ShotSize } from './score.js'; // 'cu'|'mcu'|'medium'|'wide'  (named export now exists)
   import type { GestureKind } from './score.js';
   import type { EmotionPreset } from './score.js';
   export const CAMERA_SIZE_PRESET: Record<ShotSize, { distHeads: number; targetDropHeads: number; fov: number }> = {
     cu:     { distHeads: 4.0, targetDropHeads: 0.25, fov: 30 },  // pins catalog.poseFor('cam.close')
     mcu:    { distHeads: 5.2, targetDropHeads: 0.30, fov: 32 },
     medium: { distHeads: 5.5, targetDropHeads: 0.60, fov: 35 },
     wide:   { distHeads: 9.0, targetDropHeads: 1.10, fov: 40 },  // pins catalog.poseFor('cam.wide')
   };
   export const EMOTION_ENERGY: Record<EmotionPreset, 'low'|'med'|'high'> = { neutral:'med', warm:'med', confident:'med', happy:'high', excited:'high', surprised:'high', serious:'low', concerned:'low', sad:'low', thoughtful:'low' };
   // CAMEL-CASE GestureKind (Score/performer-core vocab) → SNAKE_CASE on-disk clip filename (the integration seam).
   // null = IK-driven (point/count) or no library clip (none/explain handled by talk-base selection).
   export const GESTURE_KIND_TO_CLIP: Record<GestureKind, string | null> = {
     none: null, explain: null, point: null, count: null,        // point/count are IK; none/explain use talk-base
     wave: 'wave', present: 'open_palms', openPalms: 'open_palms',
     thumbsUp: 'thumbs_up', shrug: 'shrug', handToChest: 'hand_to_chest', clasp: 'hand_to_chest', nod: 'nod',
   };
   ```
   (These are the canonical numbers/strings `composeShot` and `resolveGesture` must reproduce; Phase 2 fixtures pin them.)
5. **`src/index.ts`** — add: `export * from './stage.js'; export * from './score.js'; export * from './performance.js'; export * from './presets.js';` **`performance.ts` re-uses `Posture` from `dsl.ts` (not redefined), so no `Posture` collision is introduced** across the two new star-exports.
6. **`scripts/gen-schema.ts`** — add `Stage, Score, ScoreBeat, Cue, CameraDirective, Performance` to the import block and the `schemas` map. Optionally surface `Mark, Target, SavedShot` as named sub-schemas.
7. **`src/stage.test.ts`** — validate a hand-written Stage (marks `center`/`left_of_screen`/`right_of_screen`/`enter_left`, **one with `facing: 'screen'`**; targets `screen`/`desk`/`camera`; one SavedShot); assert defaults populate empty arrays; assert an invalid `Target.kind` rejects; assert `Mark.facing` accepts both a number and a TargetRef string.
8. **`src/score.test.ts`** — parse the §11 example Score (move→`left_of_screen`, point→`screen`, two-shot `camera:{frame:{subjects:['self.face','screen']},follow:true}`); round-trip `emphasis`, a `WordAnchor`, a `savedShot` ref, **an `emote:{emotion:'excited',intensity:0.7}` cue**, **a `camera:{move:'dolly',amount:-0.5}` cue**, and a **`turn:{to:'screen'}` cue**; assert all **six** `Cue` variants parse and the discriminated bodies type-narrow; assert `defaults` parses.
9. Run `npm test --workspace @las/protocol`, `npm run protocol:schema`, root `npm run typecheck` + `npm run lint`.

**Primitive → task map:** Stage marks/targets/savedShots + **`Mark.facing`** → Task 1; `Score`/`ScoreBeat`/`ScoreDefaults` + the **six-verb** `Cue` (move/turn/gesture/look/camera/**emote**) + **named `ShotSize`** → Task 2; `CameraDirective` composition grammar **incl. `move`** → Task 2; `Performance` + resolved **turns** + **screen** + **audio** + **emotes** + **`BodyRef`** + 2D-safe projection (reusing `dsl.Posture`) → Task 3; preset lowering incl. the **camelCase→snake_case clip seam** → Task 4.

**Commit point:** `feat(protocol): add Stage/Score/Performance schemas + presets (additive; 6 verbs, screen/audio channels)`.

---

## Phase 2 — `performer-core` solvers implemented + golden/regression math tests

**Goal:** Replace every Phase-0 stub with real pure-math implementations, locking behavior with golden numeric tests **and regression fixtures that pin today's avatar-live hardcoded numbers**. This is the divergence-ending core; nothing consumes it yet so it can iterate freely. Includes the **three solvers the original plan omitted** (`moveCamera`, `turnToward`, `aimEye`), each with its own fixture, so **no spec §8 primitive compiles to nothing runnable** and the least-covered primitives (`look`, camera `move`, `turn`) gain solvers + tests.

**Shippable / acceptance:** `npm test --workspace @las/performer-core` green with golden fixtures for **all eight** fns, **including regression cases that reproduce today's numbers within tolerance** so the later cut-over is provably equivalent:
- `composeShot` reproduces `catalog.poseFor` `cam.close` (`hh*4.0`, `target eye-hh*0.25`, fov 30), `cam.wide` (`hh*9.0`, `eye-hh*1.1`, fov 40), the `cam.anchor` two-shot offset, and the `stage.frameAnchorScreen` two-shot: midpoint math, `fov 40`, fit `dist = (spread + 2.75)/(2·tan(fov/2))`, target `(mx+0.1, 1.25, mz+0.9)`, camera `(mx-1.1, 1.75, camZ)` (`stage.ts:176–196`).
- `fingerCount` reproduces `FINGER_CURL = [-1.0,-1.45,-1.2]` with `COUNT_PHASE 0.75` for n=1,2,3 (`avatarController.ts:75–76`, `605–640`).
- `aimLimb` reproduces the `LeftArm`/`LeftForeArm` point-aim parent-space basis (the `_aimY`/`_aimZ` orthonormal construction at `avatarController.ts:577–582`) **given the parent's world quaternion**, and auto-selects `left` from a camera-right target azimuth.
- `aimEye` reproduces `applyGaze`'s clamp/weight (`maxA = 0.5`, `weight 0.85`, `avatarController.ts:692–734`) — the `look` primitive, previously untested.
- `turnToward` reproduces `updateStation`'s travel-facing `atan2(toStation.x, toStation.z)` (`avatarController.ts:495`) and the arrival `turnTarget = 0` "face camera" datum is expressed as `Mark.facing` (not hardcoded) flowing through `planPath.arriveFacing`.
- `moveCamera` defines dolly/truck/pedestal as the local-axis deltas matching `stage.nudgeCamera(truck,pedestal,dolly)` semantics (`stage.ts:223`), and **`orbit` as a net-new arc solver** (called out in the spec camera map as not-an-orbit-today) with its own golden, not a parity case.

### Files to Modify
- `packages/performer-core/src/composeShot.ts`, `moveCamera.ts`, `planPath.ts`, `turnToward.ts`, `aimLimb.ts`, `aimEye.ts`, `resolveGesture.ts`, `fingerCount.ts`

### Files to Create
- `packages/performer-core/src/{composeShot,moveCamera,planPath,turnToward,aimLimb,aimEye,resolveGesture,fingerCount}.test.ts`
- `packages/performer-core/src/__fixtures__/regression.ts` (the pinned today-numbers, single source of truth)

### Tasks
1. **`composeShot`** — implement size→distance (head-heights), `balance` (lead-room / horizontal third offset), `height` (target drop), `lens`→fov; single-subject framing AND multi-subject (two-shot: midpoint + fit-distance from subject spread + horizontal/vertical offset). `follow:true` is just re-calling per frame **through the out-param overload** (Cross-cutting rule C — no allocation). Tolerances: position ≤ 1e-3 m, fov exact.
2. Write `__fixtures__/regression.ts` extracting the exact constants (close `hh*4.0`/fov30/drop0.25; wide `hh*9.0`/fov40/drop1.1; anchor two-shot offsets; frameAnchorScreen `-1.1/1.75/0.9`, `+0.1/1.25`, `2.75` padding; `FINGER_CURL [-1.0,-1.45,-1.2]`; `COUNT_PHASE 0.75`; gaze `maxA 0.5`/`weight 0.85`; turn `atan2` cases; point-aim parent quat + expected `LeftArm`/`LeftForeArm` quats). Each fixture is `{ input, expected }`. **Single source of truth** the eight test files import.
3. `composeShot.test.ts` — assert `composeShot` reproduces every camera regression fixture within tolerance, **and** an out-param call returns the same numbers as the allocating call (pins the perf overload). **This is the acceptance gate for the Phase-4a swap.**
4. **`planPath`** — straight-line `from→to`, arrival tolerance, carries `{ length, gait, speed, arriveFacing }` (replaces `STATION_SPEED 1.2`/`STATION_ARRIVE 0.08`, `WALK_SPEED 1.15`/`BACK_SPEED 0.75`, and — critically — resolves **arrival facing** from `Mark.facing` so "walk to left_of_screen **and face the screen**" no longer regresses); golden: sample count, endpoint equality, monotone `t`, and `arriveFacing` echoes the requested yaw.
5. **`aimLimb`** — generic 2-bone arm aim. **Signature now takes `parentWorldQuat: Quat`** (the corrected contract): build the parent-space desired quaternion by composing the world-space aim basis (the `_aimY`/`_aimZ` orthonormal construction, +Y down-the-bone) with `parentWorldQuat⁻¹`. **Rationale for the signature change:** a pure `targetDir`-only function *cannot* reproduce today's parent-space aiming, which uses `parent.getWorldQuaternion(_aimParentWorld)` (`avatarController.ts:570`) — the parent's world rotation is a required input, not derivable from a direction. The avatar-live adapter (Phase 4b Task 4) supplies it and is responsible only for bone lookup + apply, not basis math. `side:'auto'` selects `left` when the target is camera-right (the screen-on-the-left fix), `right` when camera-left. Returns `{ side, aim:{upperArm, foreArm} }` (the nesting is explicit, so the adapter destructures `const {side, aim} = aimLimb(...)` then applies `aim.upperArm`/`aim.foreArm`). Golden: pin the `LeftArm`/`LeftForeArm` quats for the screen case given the fixture parent quat; assert auto-select flips with target azimuth.
6. **`aimEye`** — head-local eye aim: clamp the yaw/pitch to `maxAngle` (default 0.5 rad), scale by `weight`; return a head-local quaternion (the morph cross-wiring `InLeft`/`OutRight` stays in the avatar-live rig binding, Phase 4b Task 5 — performer-core only produces the aim angle/quat). Out-param overload. Golden reproducing the gaze clamp/weight fixture for a few directions. **This is the `look` primitive solver — previously absent from lib + tests.**
7. **`turnToward`** — `from→to` yaw via `atan2(dx, dz)` (matching `avatarController.ts:495`); pass-through when the Score authored an absolute angle. Golden for the cardinal/diagonal cases + the "face screen from left mark" case.
8. **`moveCamera`** — relative camera ops on a base `Pose`: `truck`/`pedestal`/`dolly` as local-axis translations of both `pos` and `target` (matching `stage.nudgeCamera` axes); `pan` as a target-only yaw about `pos`; **`orbit` as a net-new arc**: rotate `pos` about `target`'s vertical axis by `amount` radians, keep `target`. Out-param overload. Goldens for each of the five; `orbit` gets a dedicated arc golden (it is new behavior, not a today-parity case).
9. **`fingerCount`** — parameterized over `FINGER_CURL` + `COUNT_PHASE`: `n = t<phase?1 : t<2·phase?2 : 3`, each finger joint `curl[j]·(1-ext)`. Out-param overload. Golden for n=1,2,3 reproducing the regression fixture. **Guarded indexing** for `curl[j]` (Cross-cutting rule B).
10. **`resolveGesture`** — pure mapping `kind → Drive` (`{clip|ik|none}` descriptor + **`baseEnergy`**, no clip loading). `point`/`count` → `{kind:'ik', ik:'aim'|'count'}`; library kinds → `{kind:'clip', clip}` via `GESTURE_KIND_TO_CLIP` (imported shape, or duplicated as a local const to keep zero-dep — see note); `none`/`explain` → `{kind:'none', baseEnergy}` where **`baseEnergy` is a returned field derived from the emotion bucket, NOT a module-global pick** — this is the fix for the `gestures.ts:98` `rotation` counter. Determinism golden: identical `(kind, params)` → identical `Drive` across repeated calls. **Note on the preset table:** performer-core must stay zero-dep (no `@las/protocol` import), so the camelCase→snake_case mapping is **duplicated** as a local const in `resolveGesture.ts` AND asserted equal to protocol's `GESTURE_KIND_TO_CLIP` by a **protocol-side test** (Phase 3 Task 5d) — the duplication is intentional (dependency direction) and guarded by a cross-check test so it cannot drift.
11. Run `npm test --workspace @las/performer-core` + `npm run build --workspace @las/performer-core` + root `npm run typecheck`.

**Primitive → task map:** `composeShot` grammar → Tasks 1–3; `planPath` (move) **+ arrival facing** → Task 4; `aimLimb` (point, corrected parent-quat signature) → Task 5; `aimEye` (**look**) → Task 6; `turnToward` (**turn**) → Task 7; `moveCamera` (**camera move**, incl. orbit solver) → Task 8; `fingerCount` (count) → Task 9; `resolveGesture` (**+ baseEnergy determinism**) → Task 10. **Regression-gate graft → Tasks 2–9** (the non-negotiable behavior-preservation gate).

**Commit point:** `feat(performer-core): implement 8 solvers + golden/regression fixtures pinning today's numbers`.

---

## Phase 3 — `compileScore()` compiler in `@las/protocol`

**Goal:** Wire the deterministic compiler `compileScore(stage, score, audioTimings, body?) -> Performance` by orchestrating `performer-core`, plus the `NewsReportDoc -> Score` back-compat bridge. Pure & deterministic, like `compileNewsReport` but spatial. **Applies `Score.defaults`, resolves `turn`/`camera move`/`Mark.facing`/`emote`-intensity, emits the screen + audio channels, and emits `self.*` as a late-bound `BodyRef`** — closing every "spec primitive with no compile task" gap.

**Shippable / acceptance:** `npm test --workspace @las/protocol` green: `compileScore` produces a `Performance` whose camera keyframes / motion paths / turns / gesture params / looks / **emotes** / **screen cuts** / **audio** / 2D-safe projection match golden fixtures; `compileNewsReportToScore(oldDoc)` lowers an existing newsreport fixture to a valid `Score` that compiles cleanly; **and the compiled `Performance` is equivalent to today's `compileNewsReport` output** for a shared fixture (Task 5e); **byte-identical output across repeated runs** (determinism guard). `npm run protocol:schema` still emits all schemas. Root `typecheck`/`lint` green. **Step 0:** `npm run build --workspace @las/performer-core` (Cross-cutting rule A).

### Files to Create
- `packages/protocol/src/scoreCompile.ts`
- `packages/protocol/src/scoreCompile.test.ts`

### Files to Modify
- `packages/protocol/src/index.ts` — export `scoreCompile`.
- `packages/protocol/package.json` — add `"@las/performer-core": "*"` to `dependencies`, AND apply Cross-cutting rule A.1 (prebuild performer-core in `build`/`typecheck`).

### Tasks
1. Add `@las/performer-core` to `protocol/package.json` deps; apply the prebuild scripts (rule A.1); `npm install`; `npm run build --workspace @las/performer-core`.
2. **`scoreCompile.ts`** — `export function compileScore(stage: Stage, score: Score, timings: AudioTimings, body?: { face?: Vec3; chest?: Vec3; root?: Vec3 }): Performance`. The `body` param is **optional and only used as a documented compile-time *default* fallback**; `self.*` refs are emitted as a **`BodyRef` marker** so the runtime re-resolves them per-frame (the compiler does NOT bake a head position). **Type/value import discipline per Cross-cutting rule B; alias `Vec3 as CoreVec3` from performer-core where both are in scope.**
   - **Defaults cascade (the omitted §5 step):** before per-beat work, fold `score.defaults` into each beat/cue that omits a value — beat `emotion ??= defaults.emotion`; `move.gait ??= defaults.gait`; a beat with no `camera` cue inherits `defaults.camera` as a sticky framing (replicating `newsreportCompile.ts:126–154` "replace + carry-forward"). Without this, authored `defaults` silently no-op.
   - **Ref resolution** — `resolveRef(ref): ResolvedTargetRef`: a `Mark`/`Target`/`SavedShot` id → `{pos}` (static); `'self.face'`/`'self.chest'`/`'self.root'` → `{bind:'face'|'chest'|'root'}` (late-bound, **never baked**); `Mark.facing` (number | TargetRef) resolved to a yaw for `planPath.arriveFacing` (TargetRef facing → `turnToward(markPos, targetPos)`).
   - **camera** — each `CameraDirective`: `{frame}` → `composeShot(subjectsFromRefs, composition)` → `CameraKeyframe` (carry `follow`; when `follow`, set `followSubjects` to the resolved refs so `self.*` subjects track the avatar at runtime); `{shot}` → the SavedShot pose verbatim; **`{move}` → a `CameraKeyframe` with `move`/`moveAmount`/`ease` set** (no absolute pose; the runtime applies `moveCamera` against the prior keyframe). Absolute time from `timings.beats[i].startSec` + `WordAnchor` offset.
   - **move** → `planPath(fromMark, toMark, {gait, arriveFacing})` → `MotionPath` (start/end from beat timing; `arriveFacing` carried).
   - **turn** (the previously-unmapped verb) → `ResolvedTurn{ tSec, yaw }`: `turn.to` number → yaw verbatim; `turn.to` Ref → `turnToward(avatarPosAtCue, targetPos)` (avatar pos taken from the most recent `move` destination, else stage `self.root` default).
   - **gesture** → `resolveGesture(kind, params)` (point/count carry IK params; `target` resolved via `resolveRef` → may be `BodyRef`) → `ResolvedGesture` **with `drive.baseEnergy` preserved** (not dropped).
   - **look** (the previously-untested verb) → `ResolvedLook{ tSec, target: resolveRef(at) }` (self.* → BodyRef so the look tracks the avatar, mirroring today's `setGazeTarget`).
   - **emote** → `ResolvedEmote{ tSec, emotion, intensity ?? 1 }` (mid-beat anchor from `at`), AND seeds the beat's projection emotion/intensity.
   - **screen** — a `camera:{... }` that authored a screen cut, or a dedicated screen directive, → `ScreenCut{ tSec, source }` (preserves today's `cam.screenSource` → back-wall montage; the whole point of the Jun-19 sync-screen-export PR).
   - **audio** — `score`/stage-level music/SFX (and, in the NewsReport lowering, `section.audio`/`d.music`) → `AudioCue[]` (preserves music beds / SFX through the mixdown).
   - **2D-safe projection** (§10) → `BeatProjection[]` `{emotion, intensity, gesture, posture}` per beat.
   - **Determinism:** no `Date`/`Math.random`/module-global counters; gesture/talk-base selection comes from `resolveGesture`'s returned `baseEnergy`, not a rotation counter.
3. **WordAnchor resolution + the out-of-range guard (the real crash path).** A small reused helper `wordStartSec(beat: BeatTiming, idx: number): number`: under `noUncheckedIndexedAccess`, `beat.words[idx]` is `WordTiming | undefined`. If `idx >= beat.words.length` (anchor past the beat), **clamp to the last word's `startSec` (or beat `startSec` if `words` is empty) and `console.warn` once** — never produce `NaN` or throw. All cue timing flows through this helper plus `pauseMsAfter` accumulation; behind a helper so it can be refined without touching solvers. Also `atOr(arr, i, fallback)` for the other indexed accesses.
4. **`compileNewsReportToScore(doc: NewsReportDoc): Score`** — map beats/sections → `ScoreBeat`s + cues; `CLOSE_SHOTS`/`WIDE_SHOTS` buckets → `CameraDirective` size; `motionTypeFor` montage gestures → `gesture` cues; section emotion → beat `emotion` (+ `emote` cues where the doc varies it); `doc.look` → `Stage.look`; **`section.audio` and `doc.defaults.music` → carried so `compileScore` emits them into `Performance.audio`** (NewsReport's music beds survive — `newsreportCompile.ts:175–189`). Reuses the existing `compileNewsReport` constants as the lowering source.
5. **`scoreCompile.test.ts`** —
   (a) **golden**: a fixed `Stage`+`Score`+`AudioTimings` → expected `Performance` (compare camera keyframes incl. a **relative `move` keyframe** and a **follow keyframe with `followSubjects`**, paths **with `arriveFacing`**, **turns**, gestures **with `baseEnergy`**, **looks**, **emotes with intensity**, **screen cuts**, **audio**, projection).
   (b) **WordAnchor timing**: a cue with `at:{word:N}` lands at exactly `timings.beats[i].words[N].startSec`; a beat with `pauseMsAfter` shifts the next beat; **an out-of-range `at:{word:999}` clamps (no NaN, no throw)** — pins Task 3's guard.
   (c) **determinism**: run twice, assert `JSON.stringify` byte-identical (guards the rotation-counter bug class).
   (d) **clip-seam cross-check**: assert protocol's `GESTURE_KIND_TO_CLIP` deep-equals performer-core's duplicated local table (imported via a tiny test-only export or re-derived) — pins Phase 2 Task 10's intentional duplication so casing can't drift.
   (e) **NewsReport equivalence (back-compat proof, not just "parses"):** take a `newsreport.test.ts` fixture, run **both** today's `compileNewsReport(doc)` and `compileScore(stage, compileNewsReportToScore(doc), timings)`; assert the Score path yields the **same camera buckets, the same gesture montage sequence, the same per-beat timing, and the same audio cues** (compare the normalized projections + camera sizes + audio, tolerant on fields the Score path legitimately enriches). This is the test the original plan's "parses and runs clean" did NOT provide.
6. Export `scoreCompile` + `compileNewsReportToScore` from the barrel; run protocol tests + `protocol:schema` + root `typecheck`/`lint`.

**Primitive → task map:** defaults cascade → Task 2 (defaults block); `self.*` late-bound BodyRef → Task 2 (Ref resolution); `turn` compile → Task 2 (turn); `camera move` compile → Task 2 (camera `{move}`); `Mark.facing` → planPath.arriveFacing → Task 2 (move); `look` compile → Task 2 (look); `emote` intensity → Task 2 (emote); screen channel → Task 2 (screen); audio channel → Task 2 (audio) + Task 4; WordAnchor + out-of-range guard → Task 3; back-compat **equivalence** → Task 5e; clip-seam cross-check → Task 5d; determinism guard → Task 5c.

**Commit point:** `feat(protocol): compileScore() spatial compiler (defaults/turn/move/facing/emote/screen/audio) + NewsReport->Score bridge`.

---

## Phase 4a — avatar-live camera adapter over `composeShot`/`moveCamera`

**Goal:** Swap the camera pose-**producing** layer (`poseFor`/`frame`/`frameAnchorScreen`/`alignToFace`) for `composeShot` (+ `moveCamera` for relative ops), keeping the generic mechanics (`setCameraPose`, `setDirector` gate, `player.ts` ease/lerp/samplePath). Single integration point: `player.resolvePose` (`player.ts:100`).

**Shippability caveat (honest, per the issue):** This phase is shippable as a **no-regression refactor** — the screen two-shot looks identical to before because Phase-2 regression fixtures pin the numbers — **but it does NOT close the live/export camera divergence.** Between 4a-merge and 4c-merge, `performer.ts:253` still calls `frameAnchorScreen(..., snap=true)` every export frame while `performer.ts:419` live-frames with smoothed `k`. That divergence is the spec's #1 correctness trap and is **closed only in 4c**. The 4a acceptance gate therefore explicitly asserts *no-regression vs today*, NOT *live==export* (that claim belongs to 4c). The phase is independently revertible; it does not *introduce* divergence, it preserves the existing one until 4c.

**Shippable / acceptance:** **Step 0** `npm run build --workspace @las/performer-core`; then avatar-live `tsc --noEmit` + `vite build` pass; live preview and offline export both frame **the same as today** (Phase-2 regression fixtures guarantee parity *with the prior build*, not live==export). **Manual smoke:** add avatar, select each shot (`shotSel`), record a short export — camera matches the pre-refactor build.

### Files to Modify
- `apps/avatar-live/package.json` — add `@las/performer-core` + `@las/protocol` to `dependencies` (today neither is declared; protocol resolves only via root hoisting). Apply Cross-cutting rule A.2 (prebuild performer-core in `build`/`typecheck`). Run `npm install` so `node_modules/@las/performer-core` + `@las/protocol` are linked.
- `apps/avatar-live/src/scene/coreAdapter.ts` (**Create**) — `Vector3 <-> Vec3` glue **with reused scratch** (rule C).
- `apps/avatar-live/src/timeline/catalog.ts` — `poseFor` → delegate to `composeShot`.
- `apps/avatar-live/src/timeline/player.ts` — `resolvePose` calls `composeShot`/`moveCamera`.
- `apps/avatar-live/src/scene/stage.ts` — `frame`/`frameAnchorScreen`/`alignToFace`/`softAlignToFace` → `composeShot`; `nudgeCamera` arrow-key path delegates to `moveCamera` (so relative moves have ONE implementation).

### Tasks
1. Add deps; apply prebuild scripts; `npm install`; `npm run build --workspace @las/performer-core`.
1a. **`coreAdapter.ts`** — `toVec3(v: THREE.Vector3, out: Vec3): Vec3` (writes into a passed tuple), `toQuat(q: THREE.Quaternion, out: Quat)`, `applyPose(stage, pose: Pose)` (copies into **module-scope reused** `THREE.Vector3`s then calls `stage.setCameraPose`), and `fromQuat(q: Quat, out: THREE.Quaternion)`. **Module-scope reusable scratch** `Pose`/`Vec3`/`Quat` + `THREE.Vector3`/`THREE.Quaternion` live here; the per-frame path uses solver out-param overloads and these scratch objects — **no `new` per frame** (Cross-cutting rule C). This adapter is the only place THREE↔core conversion happens.
2. **Replace `catalog.poseFor`'s branches** (`catalog.ts:60–86`): map each cue type to a `Composition` via `CAMERA_SIZE_PRESET` + a `subjectsForCue` helper (`cam.close→{size:'cu'}`, `cam.wide→{size:'wide'}`, `cam.anchor`/`cam.screen→two-shot`, `cam.enterLeft`/`cam.orbit→start poses`) and return `composeShot(...)` via the adapter. Keep the `CueDef`/`defaultDuration` catalog table as-is. **Leave `cam.screenSource` untouched here** — it is a vision-mixer cut, not a camera pose (it has no `poseFor` branch today and must stay out of the framing path; it moves to the Performance `screen` channel in 4c).
3. **`player.resolvePose`** (`player.ts:100`): replace `poseFor(cue.type, hc, hh)` with `composeShot(subjectsForCue(cue, hc, hh), compositionFor(cue))` (and `moveCamera` for any relative-move cue); keep the captured-pose (`cue.pose`) and recorded-path (`cue.path`) branches as solver overrides. **Indexed accesses guarded** (rule B).
4. **`stage.frame`** (`stage.ts:142`): replace factor/drop tables with `composeShot([{pos:headCenter, size:headHeight}], CAMERA_SIZE_PRESET[shot])` via the adapter.
5. **`stage.frameAnchorScreen`** (`stage.ts:176`): replace baked `-1.1/1.75/0.9` offsets + `2.75` padding with `composeShot([anchorSubject, screenSubject], {follow:true, balance:-0.3})`; `SCREEN_STAND_POS` becomes a subject. **Keep the `snap` vs smoothed-`k` apply logic in place for now** — it becomes authored `follow` damping at the apply layer in 4c. The numbers must match the regression fixture exactly.
6. **`alignToFace`/`softAlignToFace`** (`stage.ts:158`): express as a `composeShot` eyeline constraint; `k` remains the apply-layer damping (snap `k=1` vs soft `k<1`) until 4c.
7. **`nudgeCamera`** (`stage.ts:223`): the arrow-key manual path now **delegates to `moveCamera`** (truck/pedestal/dolly), so relative-move math has a single home shared with the Score `camera:{move}` path. (This was the "left unchanged" escape hatch in the original plan; unifying it now means the `move` directive compiles to runnable code end-to-end.) Keep `setCameraPose`/`setDirector`/`ease`/`lerpPose`/`samplePath` unchanged.
8. **Step 0** build performer-core; then `tsc --noEmit` + `vite build`; manual smoke (shots cycle; export camera == **pre-refactor** build for the two-shot). Note in the PR: live-vs-export divergence is *unchanged*, closed in 4c.

**Imperative → deletion/redirect map:** `catalog.poseFor` branches → `composeShot` (Task 2); `stage.frame` factor/drop tables → `composeShot` (Task 4); `stage.frameAnchorScreen` baked offsets + `2.75` padding → `composeShot` two-shot (Task 5); `alignToFace`/`softAlignToFace` → eyeline constraint (Task 6); `nudgeCamera` body → `moveCamera` (Task 7). `cam.screenSource` → **explicitly untouched** (handled in 4c).

**Commit point:** `refactor(avatar-live): camera framing via composeShot/moveCamera (parity-pinned; divergence unchanged, closed in 4c)`.

---

## Phase 4b — avatar-live motion adapter over `planPath`/`aimLimb`/`fingerCount`/`aimEye`/`turnToward`/`resolveGesture`

**Goal:** Collapse the station machine + locomotion + the **four** bespoke IK solvers (arm-aim, finger-curl, eye-aim, **turn**) + the gesture clip map into adapters over `performer-core`, **deleting** the parallel hardcoded constants — **without breaking the live Speak path or the script editor**, both of which the original plan's "Files to Modify" omitted.

**Scope honesty (per the issue):** this phase touches **five** subsystems (gesture clip map, `playGesture` regex dispatch, the station/locomotion machine across **two** files, the four IK solvers) AND the **two primary consumers the original plan missed** — `app/performer.ts`/`RealtimeSession` (live Speak) and `app/scriptEditor.ts` (tag highlighting). It is larger than its 4a/4c siblings; it is split into **ordered sub-steps each of which compiles**, and **nothing is deleted before its replacement and all its callers are migrated in the same step.**

**Shippable / acceptance:** **Step 0** `npm run build --workspace @las/performer-core`; avatar-live `tsc --noEmit` + `vite build` pass; walk-to-mark (move) **with arrival facing**, point (correct arm auto-selected), finger-count, gaze/look, turn, and the gesture library all work in live + export; **the live Speak path (RealtimeSession) still compiles and runs**; **the script editor still compiles and highlights tags**. The `gestures.ts`/`locomotion.ts` station+IK constants are deleted in favor of `performer-core`. **Smoke:** a script exercising move/point/count/wave/look/turn renders in both Speak (live) and export.

### Files to Modify (complete list — includes the previously-omitted consumers)
- `apps/avatar-live/src/avatar/gestures.ts`
- `apps/avatar-live/src/avatar/avatarController.ts`
- `apps/avatar-live/src/app/locomotion.ts`
- `apps/avatar-live/src/app/performer.ts` — **the `resolveGesture` import (line 4) + `RealtimeSession` wiring (line 86) + `buildNarration` (line 140) + `driveAvatarFrame` (line 402) all call the functions being changed; they MUST be migrated here.**
- `apps/avatar-live/src/app/scriptEditor.ts` — **imports `GESTURE_NAMES`/`EMOTION_NAMES` from `gestures.ts` (line 10) for tag highlighting + chip rows; these must be re-sourced before the tables are deleted.**
- `apps/avatar-live/src/app/avatarLibrary.ts` — **calls `avatar.setScreenStation(left, right)` at line 109; this caller must be redirected to Stage-mark data when `setScreenStation` is deleted.**

### Tasks (ordered; each compiles before the next)

**The `resolveGesture` name collision — disambiguated up front (the issue's core ask).** Two *different* functions are named `resolveGesture`:
- **OLD (avatar-live):** `gestures.ts:142` `resolveGesture(raw: string): {text, gesture, emotion?}` — a **script-line parser** (keyword inference), imported by `performer.ts:4`, passed to `RealtimeSession` (`performer.ts:86`), called in `buildNarration` (`performer.ts:140`).
- **NEW (performer-core):** `resolveGesture(kind, params): Drive` — gesture-kind → clip/IK descriptor.

**Resolution:** **rename the OLD parser to `parseScriptLine`** (it is a parser, not a resolver) in `gestures.ts` and update its three call sites (`performer.ts:4,86,140`) **in this phase, in Task 1, before importing the new `resolveGesture`.** Keyword inference (the parser's job) is NOT dropped — it stays as `parseScriptLine` because RealtimeSession + buildNarration genuinely depend on it to turn raw script lines into `{text,gesture,emotion}` for the *live Speak path that has no compiled Score*. (Authored Scores bypass it; live free-text Speak still needs it.) This removes the "two functions, same name, overlapping imports" hazard the original plan never addressed.

1. **`gestures.ts` rename + clip-map swap.**
   - Rename `resolveGesture` (parser) → `parseScriptLine`; update `performer.ts:4,86,140` to import/use `parseScriptLine`. **(Live Speak preserved.)**
   - Re-source the editor vocab **before** deleting tables: add `export const GESTURE_NAMES` / `EMOTION_NAMES` derived from `@las/protocol`'s `GestureKind`/`EmotionPreset` enums (`GestureKind.options` etc.), so `scriptEditor.ts:10` keeps working. (Do this in the same commit as the table deletion.)
   - Replace `gestureClipFor`/`selectTalkClip` internals with `resolveGesture` (from `performer-core`) + protocol's `GESTURE_KIND_TO_CLIP` + `EMOTION_ENERGY`. `gestureClipFor(kind)` becomes `resolveGesture(kind).drive.clip ?? null`. `selectTalkClip` becomes a **pure** function reading `resolveGesture(...).drive.baseEnergy` to pick the talk-base clip from the energy bucket **deterministically** (e.g. indexed by a passed `seq` counter owned by the caller/Performance, NOT a module global). **Delete** the module-global `rotation` counter (`gestures.ts:98`) and the `GESTURE_CLIPS`/`SPECIFIC`/`KEYWORDS`/`ENERGY`/`BUCKETS` tables.
   - **Reconcile the `Gesture` vocab:** the OLD `Gesture` type mixes clip-gestures (`open_palms`,`hand_to_chest`,…) AND stage-moves (`enter`,`cross_left`,`cross_right`). The stage-moves are no longer gestures — they become `move` cues (Task 3). So `Gesture` is replaced by protocol's camelCase `GestureKind` for the gesture path, and the snake_case clip filenames are reached **only** through `GESTURE_KIND_TO_CLIP`. The three stage-move members are deleted from the gesture vocab (their behavior moves to `move`).
2. **`scriptEditor.ts`** — change the import on line 10 to the new `GESTURE_NAMES`/`EMOTION_NAMES` (now protocol-derived). `CHIP_GESTURES`/`CHIP_EMOTIONS` keep working unchanged. Verify highlighting still resolves known tags. (Same commit as Task 1's table deletion, so the editor never sees a missing import.)
3. **Station machine → `move(target, gait?, speed?)` over `planPath`.**
   - Replace `goToScreen`/`goToScreenRight`/`returnToCenter`/`setStageHome`/`updateStation` (`avatarController.ts:459–508`) **and** `locomotion.ts` `tick` with one `move(target: Vec3, opts)` driven by `planPath`. **`updateStation`'s arrival facing (`turnTarget = 0` "face camera", `avatarController.ts:504`) and travel facing (`atan2`, line 495) are NOT lost** — they come from `planPath.arriveFacing` (resolved from `Mark.facing`) and `turnToward` respectively, applied via `setTurn`. So "walk to left_of_screen and face the screen" works.
   - **Redirect `avatarLibrary.ts:109`:** `avatar.setScreenStation(left, right)` is **removed**; the left/right screen marks now come from **Stage data** (`Mark` ids `left_of_screen`/`right_of_screen`) passed into the studio's Stage, not pushed into the controller per-avatar. Update `avatarLibrary.ts` to stop calling it (the marks live in the Score's Stage). (Same commit as the `setScreenStation` deletion.)
   - **Delete** `homePos`/`screenStation (0.75,0,0.4)`/`screenStationRight (2.95,0,0.4)` (`avatarController.ts:146–147`), `setScreenStation` (`avatarController.ts:454`), `STATION_SPEED`/`STATION_ARRIVE`, `WALK_SPEED`/`BACK_SPEED`/`TURN_SPEED`/`BOUND`, and the `enter` spawn-offset (`avatarController.ts:385`). Keep `playLocomotion`/`stopLocomotion` (clip apply) and the keyboard `M`-toggle as a caller of `move`. **Keep `setTurn` (`avatarController.ts:185`)** — it is now driven by `turnToward`/`arriveFacing` outputs (the `turn` verb's apply point).
4. **`applyPointing`** (`avatarController.ts:541–597`) — replace with `aimLimb(targetDir, parentWorldQuat, 'auto')`. **The adapter supplies the inputs the pure fn needs:** it does the bone lookup (`getObjectByName('LeftArm'/'LeftForeArm')` for the auto-selected side, `'RightArm'/'RightForeArm'` for the other), reads `parent.getWorldQuaternion(scratch)` (`avatarController.ts:570`) and passes it as `parentWorldQuat`, then destructures `const {side, aim} = aimLimb(...)` and applies `aim.upperArm`/`aim.foreArm` to the looked-up bones for that `side`. **Side→bone-name mapping is explicit:** `side==='left' ? ['LeftArm','LeftForeArm'] : ['RightArm','RightForeArm']`. **Delete** `POINT_AIM_WEIGHT`/`POINT_FOREARM_WEIGHT`/`POINT_AIM_TAU`/`POINT_HOLD` into solver/config params and the hardcoded `LeftArm` assumption (side now auto-selects). The +Y-down-the-bone basis math moves *into* `aimLimb` (reproduced from the regression fixture). No per-frame allocation (rule C: reused scratch + out-params).
5. **`applyCounting`** (`avatarController.ts:605–640`) — replace curl math with `fingerCount(n, t)` (out-param); keep `cacheFingerBones`/`getObjectByName('RightHand…')` bone lookup but **delete** the `FINGER_CURL`/`COUNT_PHASE`/`COUNT_TOTAL` literals (now solver params). **`applyGaze`** (`avatarController.ts:692–734`) becomes the **`look`** primitive over `aimEye`: keep the `EYE_LOOK` morph names + the `InLeft`/`OutRight` cross-wiring as the **rig binding** (avatar-specific), but take the aim angle/quat from `aimEye(dir)`; **delete** the `maxA 0.5`/`weight 0.85`/`tau 0.12` literals into `aimEye` opts/config. `setGazeTarget` (the runtime `look` target setter) stays and is fed by the Performance `looks` channel (self.* → live avatar) in 4c.
6. Build performer-core (step 0); `tsc --noEmit` + `vite build` + smoke after **each** sub-step (each independently revertible). Verify deterministic clip selection live vs export (no module-global state).

**Imperative → deletion/migration map:** OLD parser `resolveGesture` → **renamed `parseScriptLine`**, callers `performer.ts:4,86,140` migrated (Task 1); `GESTURE_NAMES`/`EMOTION_NAMES` → re-sourced from protocol enums, `scriptEditor.ts:10` migrated (Tasks 1–2); `GESTURE_CLIPS`/`SPECIFIC`/`KEYWORDS`/`ENERGY`/`BUCKETS`/`rotation` → Task 1; `Gesture` snake_case + stage-moves → `GestureKind` + `GESTURE_KIND_TO_CLIP`, moves → `move` (Task 1,3); `playGesture` regex dispatch → verb dispatch on `resolveGesture(...).drive.kind` (Task 1/3); station machine + `locomotion.ts` + `setScreenStation` + `avatarLibrary.ts:109` caller → `move`/Stage data (Task 3); `applyPointing`+`POINT_*`+`LeftArm/LeftForeArm` → `aimLimb` with explicit side→bone map (Task 4); `applyCounting`+`FINGER_CURL`+`RightHand{finger}{j}` → `fingerCount` (Task 5); `applyGaze`+`maxA/weight/tau` → `aimEye` (**look**, Task 5).

**Commit point:** `refactor(avatar-live): motion/IK/gestures/turn/look via performer-core; rename parser→parseScriptLine; migrate scriptEditor+avatarLibrary; delete constants`.

---

## Phase 4c — avatar-live single drive path: `score.drive(t, dt, mouth)` (+ screen + audio channels)

**Goal:** Unify the live tick + offline export onto one `Performance`-consuming drive method, **eliminating the documented divergences** (camera override, mouth source, gesture rotation, clock) **and routing the screen-cut and audio channels through the same Performance** (so the back-wall montage sync and music beds keep working). **This is the definition of done for the camera unification, and the first point at which "each phase independently shippable + non-divergent" actually holds.**

**Shippable / acceptance — the explicit, falsifiable milestone:** route **both** `performer.ts:247` export closure **and** `performer.ts:412` live tick through one `score.drive()`, and **DELETE the `performer.ts:253` `frameAnchorScreen(..., snap=true)` override**, verified by a **headless `scoreDrive` parity vitest** (infrastructure specified below — this is NOT a manual eyeball check). **Step 0** `npm run build --workspace @las/performer-core`; avatar-live `tsc --noEmit` + `vite build` + `npm test --workspace @las/avatar-live` (the new parity test) pass.

### Test infrastructure (specified, so the parity gate is real — the issue's central complaint)
avatar-live has **zero** test files today; root `npm test` only runs protocol vitest. To make the parity gate runnable rather than an eyeball check, this phase **stands up the harness**:
- Add `vitest` + `@vitest/web-worker` (if needed) and a **`test` script** (`"test": "npm run build --workspace @las/performer-core && vitest run"`) to `apps/avatar-live/package.json`, and a `vitest.config.ts` with `environment: 'node'` using the **headless GL** stack the GPU pod already uses: `gl` (headless-gl) + a minimal `THREE.WebGLRenderer` backed by it, OR — preferred for cost — **a render-free parity test that exercises `score.drive`'s math without a real GL context** by injecting a **fake stage** (an object implementing `setCameraPose`/`cameraWorldPosition`/`seekScreen` recording calls) and a **fake avatar** exposing `headCenter`/`headHeight`/`group.position`/`setTurn`/`setEmotion`/`setMouth`/`playGesture` as spies. `score.drive` is written to depend only on these interfaces, NOT on concrete THREE objects, so the parity test needs **no WebGL at all** — it asserts the *commands* `drive` issues (camera pose, gesture, turn, emotion, screen-cut, mouth) are identical for the two clocks. This converts the "needs a loaded GLB + AudioContext + WebGL" blocker into an interface-injection test.
- **Fixture Performance:** a small compiled `Performance` checked into `src/__fixtures__/` (built by calling `@las/protocol` `compileScore` on a fixture Score/Stage/timings at test time, or a frozen JSON). **Fixture avatar geometry** is just `{headCenter:[0,1.5,0], headHeight:0.42}` injected into the fake avatar — no GLB load.
- **Mouth** is injected (see Task 1), so no AudioContext is needed in the test.

### Files to Create
- `apps/avatar-live/src/app/scoreDrive.ts` — `class ScoreDrive { drive(t, dt, mouth) }` depending on **injected `StageLike`/`AvatarLike` interfaces** (enabling headless test).
- `apps/avatar-live/src/app/scoreDrive.parity.test.ts` — fixed-`t` command-parity vitest (the acceptance gate) **+ a follow-damping parity case** (below) **+ an allocation-budget assertion** (rule C).
- `apps/avatar-live/src/app/__fixtures__/performance.fixture.ts` (or `.json`).
- `apps/avatar-live/vitest.config.ts`.

### Files to Modify
- `apps/avatar-live/package.json` — add `vitest` dev-dep + `test` script (with performer-core prebuild).
- `apps/avatar-live/src/app/performer.ts` — `driveAvatarFrame` + both callers become thin `score.drive` calls; **delete line 253**.
- `apps/avatar-live/src/timeline/player.ts` — `fireMotion` once-latch → Performance one-shot lookup; **`updateScreenSource` (`player.ts:62`) → the Performance `screen` channel** (so the cut still fires, now from `Performance.screen` not the raw cue).

### Tasks
1. **`scoreDrive.ts`** — `drive(t, dt, mouth: MouthCue)` consuming a compiled `Performance`: `mouth` is an **injected input** (live `analyser.sample()` / offline `precomputeMouthTrack`), never computed inside. In one place, for time `t`, it:
   - advances **emotion/intensity** (from `Performance.emotes` + beat projection) via `avatar.setEmotion(name, intensity)`;
   - advances **gesture** (timed `Performance.gestures` lookup; `drive.kind` → clip vs IK; talk-base from `drive.baseEnergy` deterministically, no module global) via `playGesture`/IK;
   - advances **turn** (`Performance.turns`) via `avatar.setTurn(yaw)`;
   - advances **look** (`Performance.looks`) via `avatar.setGazeTarget(resolved)` — **resolving `BodyRef` per-frame** (1a);
   - resolves the **camera** `CameraKeyframe` for `t` — interpolating with `ease`, applying relative `move` via `moveCamera` against the prior keyframe, and **when `follow`: re-running `composeShot(followSubjects resolved per-frame)`** through the adapter (out-params, rule C);
   - advances the **screen channel** (`Performance.screen`) via `stage.seekScreen(t)` / screen-source set;
   - (audio is scheduled once up-front by the existing `scheduleAudioCues`/`renderMixdown` from `Performance.audio` — see Task 7 — not per-frame).
1a. **`self.*` runtime resolution (the un-rooted-ref fix).** A `BodyRef` (`{bind:'face'|'chest'|'root'}`) in a camera `followSubjects`, a `look.target`, or a `gesture.target` is resolved **every frame** against the live avatar: `face → avatar.headCenter (+ group.position)`, `chest → a chest offset below headCenter`, `root → avatar.group.position`. This is exactly how today's gaze (`setGazeTarget(cameraWorldPosition)`) and two-shot (`group.position`) track the avatar — now generalized. The compiler never bakes these; the runtime owns them.
2. **Make `follow` authored data, not a hidden per-path override:** the two-shot snap-follow is read from `CameraKeyframe.follow` (compiled from `CameraDirective.follow`). The **damping** is also authored: `follow:true` keyframes carry the smoothing behavior, and **the live/export difference becomes the `dt` fed to the damping, not a `snap` boolean** — i.e. the *same* `1 - exp(-dt/τ)` follow term runs on both paths with `τ=0.45` (today's live value, `stage.ts:190`), so export no longer snaps. (If a hard snap is ever wanted, it is `τ→0` authored, not a code branch.) This is the correctness-trap mitigation for `performer.ts:253`, and it makes the **follow lag identical** on both paths — which the parity test pins (Task 6 follow case).
3. **`performer.ts`** — `driveAvatarFrame` (`385–409`), the live render-branch (`424–434`), and the export closure (`247–254`) all become thin `score.drive(t, dt, mouth)` calls. **Delete the `frameAnchorScreen(..., snap=true)` line (`performer.ts:253`)** and the live auto-frame asymmetry (`performer.ts:419`) — both paths now get camera (and screen, and gesture, and turn, and look, and emotion) from the Performance. **Delete the dual `selectTalkClip`/`gestureClipFor` calls at `performer.ts:71,402`** — gesture/talk-base now flow through `score.drive` from the Performance's `baseEnergy`, so the talk-base determinism fix actually reaches the runtime. **Live Speak (RealtimeSession):** its `onSegmentStart` still uses `parseScriptLine` (from 4b) to build a Score on the fly OR feeds segments into `score.drive` via an incrementally-built Performance — whichever the implementer picks, but the **same `score.drive`** consumes it (no second drive path).
4. **Replace `narrationSegs` flat array + `{idx}` cursor** (`performer.ts:44,396–407`) with `Performance` timed-event lookup; **replace `TimelinePlayer.fireMotion`** once-latch (`player.ts:106`) and **`updateScreenSource`** (`player.ts:62`) with `Performance` one-shot semantics keyed by `t` (the screen cut now lives in `Performance.screen`, not as a raw `cam.screenSource` cue interpreted inline — preserving the Jun-19 montage-sync behavior through the unified path).
5. Ensure **no `performance.now()`** on the drive path (export is frame-stepped `t=i/fps`); keep the screen channel seekable (`stage.seekScreen(t)`, `stage.ts:288`) for export.
6. **`scoreDrive.parity.test.ts`** (the acceptance gate, now runnable headless):
   - **Command parity at fixed `t`:** drive the fixture Performance through both the frame-stepped (export) clock and a simulated live clock at `t ∈ {0, 0.5, 1.0, 1.5, …}`; assert the **recorded camera pose / gesture / turn / emotion / screen-source commands** match within tolerance (camera pos/target ≤ 1e-3, fov exact), modulo the legitimate injected-mouth difference.
   - **Follow-damping parity (the term the original plan never pinned):** drive a `follow:true` two-shot across a *sequence* of frames where the followed subject moves between frames; assert the camera position **trajectory** (not just fixed-`t` value) produced by export and live is identical because both now apply `1 - exp(-dt/0.45)` with their respective `dt` — and assert a **snap-vs-smoothed regression guard**: a test that *forces* `snap k=1` produces a *different* trajectory, proving the test can detect the very lag difference that was the original bug. (A boolean can't capture "snap vs 0.45s ease"; a multi-frame trajectory assertion can.)
   - **selectTalkClip determinism across a live-then-export sequence (the actual reported divergence):** run the talk-base selection through a live segment sequence, then the same sequence in export; assert the chosen clip sequence is identical (pins that `baseEnergy`-driven selection is order-stable and not a module-global `rotation`).
   - **Allocation budget (rule C):** drive 300 frames steady-state; assert per-frame heap-delta stays below a small threshold (coarse GC-churn guard).
7. **Audio:** `score.drive`'s owner schedules `Performance.audio` once at playback/export start via the existing `scheduleAudioCues` (`timelineEditor.ts:129`) for live and `renderMixdown` (`offlineAudio.ts:18`, used by `offlineExporter.ts:35`) for export — so music beds / SFX survive the migration unchanged. (Audio is not per-frame; it is scheduled from the Performance channel.)
8. Build performer-core (step 0); `tsc --noEmit` + `vite build` + `npm test --workspace @las/avatar-live` + manual live-vs-export MP4 smoke (now backstopped by the automated parity test).

**Imperative → deletion map:** `performer.ts:253` `frameAnchorScreen(snap=true)` override → **deleted** (Task 3, the milestone); `performer.ts:419` live auto-frame → deleted (Task 3); `performer.ts:71,402` `selectTalkClip`/`gestureClipFor` → Performance `baseEnergy` via `score.drive` (Task 3); `narrationSegs`+`{idx}` cursor → Performance lookup (Task 4); `fireMotion` once-latch + `updateScreenSource` → Performance one-shot `screen` channel (Task 4); dual mouth/clock divergence → injected-mouth + frame-clock (Tasks 1,5); follow `snap` boolean → authored `τ` damping (Task 2).

**Commit point:** `refactor(avatar-live): single score.drive() for live+export incl. screen+audio; delete frameAnchorScreen snap-override (headless-parity-verified)`.

---

## Phase 5 — Authoring / emission: bridge + director emit Scores (deferred, optional)

**Goal:** Let authored data enter as Scores: `bridge.applyNewscast` accepts/validates a `Score`, the director LLM emits Scores, old `NewsReportDoc` still compiles via `compileNewsReportToScore`, **and a defined `Performance → studio` load path exists** (the original plan wired the bridge but left the compiled Performance with nowhere to land). Touch control-api / bridge / director **last**, gated on the runtime being proven (**4c green**, including the parity test).

**The Performance→studio landing path (the missing consumer, now specified).** Today `dispatch.ts:99` calls `c.projects.importNewsReport(params.doc)` → `projectStore` `validateNewsReportDoc` + `compileNewsReport` + `applyProject(CompiledProjectDoc)`. A compiled `Performance` is a **different shape** than `CompiledProjectDoc`, so it cannot reach the runtime through `applyProject`. This phase adds the path:
- **`projectStore.importScore(score, stage, timings)`** (or `applyPerformance(perf: Performance)`) that calls `@las/protocol` `compileScore` and hands the resulting `Performance` to the **`ScoreDrive` owner** stood up in 4c (the studio holds a current `Performance`; `score.drive` consumes it). This is the *defined consumer* of a compiled Performance.
- `dispatch.applyNewscast` routes: `validateScore(doc)` → `importScore`; on failure `validateNewsReportDoc(doc)` → `compileNewsReportToScore` → `importScore` (the proven old path now flows through the *same* Score runtime, not a parallel `compileNewsReport`/`applyProject` — though `applyProject` stays available for any non-Score legacy callers during transition).

Because this lands the Performance in 4c's `ScoreDrive`, **Phase 5 is correctly gated on 4c**, and the data now has a defined home.

**Shippable / acceptance:** protocol `validateScore` tests green; `bridge.applyNewscast` round-trips a Score and the studio renders it via `score.drive`; the director prompt emits a Score that compiles; `jobs.ts` `Job.spec` carries Score+Stage with **no envelope change**. **Old `NewsReportDoc` path still works end-to-end, proven by Phase 3 Task 5e's equivalence test** (not merely "validates"). **Step 0** `npm run build --workspace @las/performer-core`.

### Files to Modify
- `packages/protocol/src/bridge.ts` — `applyNewscast`/`validateNewscast` accept a Score doc (the `z.unknown()` doc param documented to validate via `validateScore`).
- `packages/protocol/src/director.ts` — `buildDirectorSystemPrompt` emits Scores (preset + named-ref heavy per §13).
- `apps/avatar-live/src/bridge/dispatch.ts` — `applyNewscast`/`validateNewscast` handlers (`dispatch.ts:98–122`) accept Score (keep `NewsReportDoc` via `compileNewsReportToScore`), routing to the new `importScore`.
- `apps/avatar-live/src/app/projectStore.ts` — **add `importScore`/`applyPerformance`** (the landing path).
- `packages/protocol/src/director.test.ts` (**Create**) — director-Score corpus.

### Tasks
1. **`bridge.ts`** — keep `NewscastDocParams = z.object({ doc: z.unknown() })` envelope; document that `doc` validates as a `Score` (or `NewsReportDoc`, auto-lowered). No `BridgeCommand` shape change.
2. **`projectStore.ts`** — add `importScore(doc, stage, timings)`: `validateScore` → `compileScore` → set the studio's current `Performance` on the `ScoreDrive` owner (4c). Add `applyPerformance(perf)` if a pre-compiled Performance is passed.
3. **`dispatch.ts`** (avatar-live) — `applyNewscast`: try `validateScore(params.doc)` → `importScore`; on failure fall back to `validateNewsReportDoc` → `compileNewsReportToScore` → `importScore`. `validateNewscast` mirrors (validate-only). The old `importNewsReport`/`applyProject` path remains for any legacy non-Score callers but newscast docs now flow through the Score runtime.
4. **`director.ts`** — swap the inlined `EMOTIONS/GESTURES/POSTURES` JSONL prompt for a Score-emitting prompt (named Stage refs, optional params; presets over raw numbers). Add `director.test.ts` asserting a sampled director output parses via `validateScore` and `compileScore` runs clean.
5. **`jobs.ts`** — `Job.spec`/`QueueMessage.spec` stay `z.unknown()`; document they may carry `{ score, stage }`. `JobStatus` (`compiling`/`rendering`) unchanged.
6. Keep `compileNewsReportToScore` as the back-compat entry. Run protocol tests + `protocol:schema` + root `typecheck`/`lint`.
7. **Document** the cut-over; mark engine-three re-adoption (spec §12.4) as **N-A / deferred** (engine-three is no longer in the workspace).

**Commit point:** `feat(protocol,avatar-live): bridge + director emit Scores; importScore landing path; NewsReport auto-lowers`.

---

## Phase 6 — WebMCP v1 server wrapping existing bridge handlers (parallelizable, late)

**Goal:** Expose the studio's proven Bridge handlers as a **WebMCP v1** tool surface. This is **independent of Phases 1–5** (it wraps the *existing* `BridgeCommand` handlers, not the Score runtime) and can be built in parallel by a separate branch; it only needs `@las/protocol`'s bridge contracts, which already exist. When Phase 5 lands, the same WebMCP tools transparently accept Scores (the handler underneath changed, the tool surface did not).

**Shippable / acceptance:** the WebMCP server starts and lists tools; each tool validates its args against the `BridgeCommand` schema and forwards to the existing dispatcher; a smoke client can call e.g. `applyNewscast`/`setScript`/`captureView` end-to-end against a running studio (`?bridge=9777`). `tsc --noEmit` for `services/newsroom-mcp` green.

### Files to Modify / Create
- `services/newsroom-mcp/src/tools/webmcp.ts` (**Create**) — register WebMCP v1 tools that wrap `BRIDGE_COMMANDS`.
- `services/newsroom-mcp/src/server.ts` — add the new tool module to `TOOL_MODULES` (the existing `registerTool` + `registerAllTools` pattern).

### Tasks
1. Enumerate `BRIDGE_COMMANDS` and generate a WebMCP tool per command, with `inputSchema` derived from the matching `BridgeCommand` variant (reuse `parseBridgeCommand`/`parseBridgeRequest` from `@las/protocol`).
2. Each tool handler builds a `BridgeRequest` and forwards over the existing Studio Bridge transport (`transport.ts`) to the connected `avatar-live` studio; map `BridgeResult` → the WebMCP tool result.
3. Register the module via `registerTool` in `TOOL_MODULES` so `registerAllTools(server)` picks it up; keep all existing MCP tools intact.
4. Smoke: start the server, list tools, drive a running studio (`applyNewscast` with a Score once Phase 5 is merged, or a `NewsReportDoc` before then — same tool). `tsc --noEmit` for the service.

**Commit point:** `feat(newsroom-mcp): WebMCP v1 server wrapping Studio Bridge handlers`.

---

## Test Strategy (no CI — layered, local, matches the two existing harnesses + a NEW avatar-live harness)

0. **Build ordering is a test prerequisite.** Every test/typecheck command that touches a performer-core consumer runs `npm run build --workspace @las/performer-core` first (baked into the `build`/`typecheck`/`test` scripts of protocol and avatar-live — Cross-cutting rule A). A stale dist silently shipping old math is itself the failure this guards against.
1. **`performer-core` is the test backbone.** All **eight** pure fns get **golden** numeric fixtures and **regression** fixtures pinning today's avatar-live numbers (`poseFor` close/wide/anchor; `frameAnchorScreen` `-1.1/1.75/0.9` + `2.75`; `FINGER_CURL [-1.0,-1.45,-1.2]`; `COUNT_PHASE 0.75`; point arm-aim parent-quat basis; **gaze `maxA 0.5`/`weight 0.85` for `aimEye`**; **`atan2` turn cases for `turnToward`**; **`nudgeCamera`-axis deltas + a net-new orbit arc for `moveCamera`**). Out-param overloads are asserted equal to allocating calls. These make the Phase-4 cut-over **provably** behavior-preserving, and are the **binding contract** a future engine-three must match byte-for-byte. `npm test --workspace @las/performer-core`.
2. **`protocol` schema/compiler.** vitest in `packages/protocol`: schema parse/round-trip for Stage/Score/Performance (all **six** Cue variants, `Mark.facing`, `emote` intensity, `camera move`, `defaults`); a `compileScore` golden covering camera (incl. relative move + follow `followSubjects`), motion (incl. `arriveFacing`), turns, looks, emotes, **screen cuts**, **audio**, projection; **WordAnchor timing + out-of-range clamp**; a **determinism** test (byte-identical); a **clip-seam cross-check** (protocol vs performer-core casing tables); and the **NewsReport equivalence test** (old `compileNewsReport` output ≈ Score-path output for a shared fixture — back-compat *proven*, not assumed). `npm run protocol:schema` must still emit all schemas incl. the new ones.
3. **avatar-live (Phases 4a/b/c) — a NEW harness, specified, not assumed.** `tsc --noEmit` + `vite build` after **each** sub-swap; **plus a real `vitest` harness** (added in 4c) running the **headless `scoreDrive` parity test via injected `StageLike`/`AvatarLike` interfaces + a fixture Performance** — NO WebGL/GLB/AudioContext required, because `score.drive` is written against interfaces and mouth is injected. The parity test pins: **command parity at fixed `t`**, **multi-frame follow-damping trajectory** (catches the snap-vs-0.45s-ease lag a boolean can't), **selectTalkClip determinism across a live-then-export sequence** (the actual reported bug), and a **per-frame allocation budget**. The 4a/4b gates assert *no-regression vs the prior build* (live/export divergence is explicitly still present and *bounded*); the 4c parity gate asserts *live==export*. Manual MP4-vs-live smoke remains as a backstop, but is no longer the *sole* gate.
4. **Phase 5.** `validateScore` tests + a director-Score corpus + a bridge round-trip that lands a Performance in `ScoreDrive` via `importScore`; the NewsReport equivalence test (Phase 3 Task 5e) is the back-compat gate.
5. **Phase 6.** WebMCP server starts, lists tools, drives a running studio over the existing transport.
6. **Throughout:** root `npm run typecheck` and `npm run lint` before each phase ships; **all sketches obey `noUncheckedIndexedAccess`/`verbatimModuleSyntax`/`isolatedModules`** (guarded indexing helpers `atOr`/`wordStartSec`, `import type`/`export type` discipline, `Vec3`/`Posture`/`ShotSize` single-source). Each phase is a **branch → PR → merge** (push-to-`main` blocked); the studio must build + smoke green before merge.

## Risks & Mitigations

- **Build-graph hazard (highest severity): stale/missing `performer-core/dist`.** dist is gitignored; consumers resolve it via `node_modules/.../dist`, not a src alias. *Mitigation (Cross-cutting rule A):* `prepare` script builds dist on install; protocol/avatar-live `build`/`typecheck`/`test` scripts prebuild performer-core; every phase gate lists the build as step 0; README note for fresh clones. A stale dist can no longer silently ship old math.
- **Single-engine cost of the plain-vector boundary.** Only avatar-live consumes performer-core; the tuple↔THREE conversion + quaternion round-trip is real per-frame overhead the current code engineers away. *Mitigation:* keep the boundary (for testability + future engine-three) but mandate **out-param overloads + reused scratch in `coreAdapter`** (Cross-cutting rule C) and **assert the allocation budget in the parity test**. The cost is bounded and *tested*, not assumed cheap.
- **`performer.ts:253` is a correctness trap, not a refactor — and 4a/4b don't fix it.** *Mitigation:* state honestly that 4a/4b are *no-regression* refactors that **preserve** the existing divergence (bounded, known), and it is **closed only at 4c** by deleting the snap-override and authoring `follow` damping (same `τ` on both paths). The 4a/4b gates assert no-regression; the 4c gate asserts live==export with a **multi-frame trajectory** test that a boolean snap can't pass.
- **The parity gate degrading to eyeballing (no avatar-live test infra today).** *Mitigation:* `score.drive` depends on **injected `StageLike`/`AvatarLike` interfaces**, so the parity vitest runs **headless with no WebGL/GLB/AudioContext** — it asserts the *commands* `drive` issues. This makes the "provable equivalence" promise actually executable, not aspirational.
- **Spec primitives with no compile/solver path** (`emote` intensity, `turn`, camera `move`/`orbit`, `Mark.facing`, `look`). *Mitigation:* `emote` carries intensity through Cue→Performance→`setEmotion`; `turnToward`/`moveCamera`/`aimEye` are net-new performer-core solvers with their own goldens; `Mark.facing` flows `planPath.arriveFacing`; every spec §8 verb has a named solver or an explicit "no solver" note (Phase 0/2 maps).
- **`self.*` un-rooted.** *Mitigation:* compiler emits `self.*` as a late-bound `BodyRef`; `score.drive` resolves it **per-frame** against the live avatar (`headCenter`/`group.position`), exactly like today's gaze/two-shot. Never baked at compile time.
- **Lost channels on the Score path** (back-wall montage, music beds). *Mitigation:* `Performance` gains a **`screen`** channel (preserving `cam.screenSource` → the Jun-19 sync-export behavior) and an **`audio`** channel (preserving `section.audio`/`d.music` → `renderMixdown`); `score.drive` + `scheduleAudioCues` route both. The original plan dropped both.
- **Deletion-before-replacement** (script editor `GESTURE_NAMES`/`EMOTION_NAMES`, `avatarLibrary.setScreenStation`, the `resolveGesture` name collision). *Mitigation:* Phase 4b's **complete** "Files to Modify" includes `performer.ts`/`RealtimeSession`/`scriptEditor.ts`/`avatarLibrary.ts`; the parser is **renamed `parseScriptLine`** (keyword inference preserved for live Speak) and its callers migrated *in the same step* before the new `resolveGesture` is imported; vocab is re-sourced from protocol enums before the tables are deleted; `setScreenStation`'s caller is redirected to Stage marks in the same commit. Nothing is deleted before its replacement + callers land.
- **`baseEnergy`/talk-base determinism lost at the Performance boundary.** *Mitigation:* `ResolvedGesture.drive` carries **`baseEnergy`**; `score.drive` reads it (no module-global `rotation`); the parity test pins talk-clip selection determinism across a **live-then-export** sequence. The fix survives serialization.
- **tsconfig strictness breaking sketches** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`). *Mitigation:* Cross-cutting rule B — guarded indexing helpers, `import type`/`export type` discipline, single-source `Vec3`/`Posture`/`ShotSize`, the **out-of-range WordAnchor** treated as a defined clamp (tested), not a crash.
- **Duplicate/colliding symbols** (`Posture` x2, `Vec3` x2, `ShotSize` missing, `GestureKind` x3). *Mitigation:* `performance.ts` **reuses `dsl.Posture`** (no redefine); `score.ts` **exports a named `ShotSize`** (fixes the `presets.ts` import); `Vec3` is aliased at the one boundary (`scoreCompile.ts`, `coreAdapter.ts`); the camelCase↔snake_case gesture seam has a **single authority** (`GESTURE_KIND_TO_CLIP`) cross-checked between protocol and performer-core by a test.
- **`aimLimb` signature can't reproduce parent-space aiming.** *Mitigation:* the corrected signature **takes `parentWorldQuat`** (the missing input); the adapter supplies it via `parent.getWorldQuaternion` and owns side→bone-name mapping; the +Y basis math lives in `aimLimb`, pinned by the regression fixture.
- **Performance→studio has no consumer (Phase 5 data nowhere to land).** *Mitigation:* Phase 5 adds **`projectStore.importScore`/`applyPerformance`** that hands a compiled `Performance` to 4c's `ScoreDrive`; Phase 5 is gated on 4c precisely because that is the landing path.
- **Phase 4b scope.** Five subsystems + two missed consumers in one phase. *Mitigation:* ordered sub-steps that each compile; the full consumer list (`performer.ts`/`RealtimeSession`/`scriptEditor.ts`/`avatarLibrary.ts`) is in-scope; typecheck+build+smoke after each sub-step; do **not** delete an imperative path until its adapter + all callers pass.
- **engine-three already gone.** The spec's "two engines, one runtime" motivation is single-engine today. *Mitigation:* still build performer-core pure/agnostic (testability + future re-adoption; fixtures pin the contract) but scope the cut-over to avatar-live and treat §12.4 as deferred/N-A; the plain-vector cost is paid down by rule C.
- **WordAnchor / `audioTimings` shape undefined in spec §13.** *Mitigation:* a minimal per-word `AudioTimings` is settled in Phase 1; resolution sits behind `wordStartSec` (Phase 3) with the out-of-range clamp tested.
- **LLM-emittability of the richer Score (§13 top risk).** *Mitigation:* Score stays preset + named-ref heavy (params optional); director changes deferred to Phase 5, gated on a director-Score corpus; `compileNewsReportToScore` keeps the proven path as fallback, with the equivalence test proving parity.