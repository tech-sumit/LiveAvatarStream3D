# Newscast DSL — Design Spec

**Date:** 2026-06-21
**Status:** Design (authoritative for the `NewsReportDoc` v2 contract)
**Project:** LiveAvatarStream3D — browser Three.js talking-avatar news studio

## Abstract

The **Newscast DSL** is one canonical, version-stamped document — the `NewsReportDoc` (`version: 2`) — that fully describes a televised news broadcast: a multi-section **rundown** of stories, each with narration, avatar performance (emotion / gesture / posture / gaze), camera motion, transitions, lighting, back-screen / set, on-screen graphics, and audio. Importing one document configures the *entire* editor; pressing **Record** performs the whole document deterministically and delivers a finished MP4. The design intent is "director + writer + producer combined." The DSL is authored through three interchangeable surfaces — canonical zod-validated JSON (the LLM/wire/contract format in `packages/protocol`), a Fountain-like `.ncast` screenplay, and an embedded-TS fluent builder — all converging on the same JSON, which a single deterministic compiler lowers to **both** render backends: the in-browser `apps/avatar-live` performer (frame-exact WebCodecs→MP4) and the headless GPU `services/engine-three` renderer (premium master). This spec is the maximal, exhaustive contract for that document, its vocabulary, its compile and runtime flow, and the two foundational subsystems (frame-exact export, post-processing look). **§2 is authoritative for all type and field names; later sections defer to it.**

---

## Table of Contents

1. [Overview, goals/non-goals, glossary, architecture & data flow](#1-overview-goalsnon-goals-glossary-architecture--data-flow)
2. [Canonical schema (`NewsReportDoc`) — full type reference](#2-canonical-schema-newsreportdoc--full-type-reference) **(AUTHORITATIVE)**
3. [The `.ncast` screenplay grammar + TS builder](#3-the-ncast-screenplay-grammar--ts-builder)
4. [Complete vocabulary (enums, existing vs new)](#4-complete-vocabulary-enums-existing-vs-new)
5. [Rundown & timing model](#5-rundown--timing-model)
6. [Feature semantics — WRITER / DIRECTOR / PRODUCER (exhaustive)](#6-feature-semantics--writer--director--producer-exhaustive)
7. [Compile / lowering rules + import & Record runtime flow](#7-compile--lowering-rules--import--record-runtime-flow)
8. [Subsystem designs — SP-1 MP4/4K export + SP-2 camera filters/look](#8-subsystem-designs--sp-1-mp44k-export--sp-2-camera-filterslook)
9. [Worked examples + testing + build order](#9-worked-examples--testing--build-order)

> **Reading guide.** §1 orients. **§2 is the single source of truth for every type, field, and enum** — when any other section appears to disagree on a name or shape, §2 wins. §3 (authoring surfaces), §4 (vocabulary), §5 (rundown/timing), §6 (feature semantics), §7 (compile/runtime), and §8 (export/look subsystems) all reference §2 rather than redefining it. §9 gives conformance-anchor examples that validate against §2 + §3 + §4.

> **Tiering.** Every feature is tagged **MVP / V2 / Later**. The **MVP cut line** sits between build steps **SP-3 and SP-4** (see §9.5). MVP = author a `NewsReportDoc` v2 (canonical JSON), import into avatar-live, Record a frame-exact MP4 with the `broadcast` look, driving narration + emotion + gesture + camera + pause + lighting + back-screen + headline + music across a basic multi-section rundown (READER/VO sections). `.ncast` text, full SSML, transitions, lower-thirds/ticker, ducking, WPM auto-timing, wired postures, and gaze are **V2**; multi-camera, multi-avatar, brand kit, captions, ad-break scheduling, and time-manipulated B-roll are **Later**.

---

## 1. Overview, Goals/Non-Goals, Glossary, Architecture & Data Flow

### 1.1 Overview

The **Newscast DSL** is a single, canonical, version-stamped document — the `NewsReportDoc` (`version: 2`) — that fully describes a televised news broadcast: a multi-section **rundown** of stories, each with narration, avatar performance (emotion / gesture / posture / gaze), camera motion, transitions, lighting, back-screen / set, on-screen graphics, and audio. Importing one `NewsReportDoc` configures the *entire* editor; pressing **Record** performs the whole document deterministically and delivers a finished MP4. The design intent is "director + writer + producer combined": the writer authors copy, the director blocks camera and performance, the producer schedules graphics, audio, ad-breaks, and the look — all in one artifact.

The document drives **two render backends** from one compile step:

- **`apps/avatar-live`** — the realtime browser news studio (primary import/Record surface). Renders Three.js in-browser and exports a frame-exact MP4 via WebCodecs (chore SP-1).
- **`services/engine-three`** — the headless GPU renderer (`gl` + Xvfb on an H100 pod) for offline / premium masters.

It also supports **three authoring surfaces** that all converge on the same canonical JSON, so an LLM, a writer, and a programmer can each work in their preferred form.

### 1.2 Goals

- **One document configures everything.** A single `NewsReportDoc` import fans out to every editor subsystem (narration, performance, camera, look, set, graphics, audio, music) with no manual follow-up.
- **Deterministic Record → MP4.** Given the same document + voice + assets, Record produces byte-stable timing and frame-exact output. The clock is driven by frame index `t = i / fps` (not `rAF`); no retries on render.
- **Full rundown in v1.** Multi-section newsroom rundown, split into blocks by ad-breaks, with per-section **story-forms** (`READER | VO | VOSOT | PKG | LIVE | LOOK_LIVE | DONUT | MOS | STANDUP | KICKER`).
- **Three interoperable authoring surfaces** (see §1.4) round-tripping to the same JSON.
- **Two render backends** from one compiler — browser (`ProjectDoc` + `Cue[]`) and GPU (`EngineRenderSpec` / `PerformanceManifest`).
- **Cinematic look** via a `PostProcessingSpec` (`look`) applied identically on both backends (chore SP-2).
- **Additive reuse.** Extend `packages/protocol` and `apps/avatar-live`'s `ProjectDoc`; do not reinvent the DSL, the manifest compiler, or the editor fan-out.
- **Sticky carry-forward semantics.** Camera, look, set, and background persist across beats and sections until overridden (Ren'Py-style), matching `compileManifest()`'s existing behavior.

### 1.3 Non-Goals

- **Not a live-production switcher / vision mixer.** Multi-camera *switching*, two-shot/OTS multi-avatar, and live source ingest are **Later** tier, not MVP.
- **Not a teleprompter or live-to-air system.** No realtime operator cueing, no live latency budget; this is authored-then-rendered.
- **Not a general video NLE.** B-roll/clip time-manipulation, captions (608/708, dirty/clean), and full brand-kit theming are **Later**.
- **Not a TTS/voice-clone engine.** Voice cloning and timing come from the existing voice pipeline; the DSL only references `voiceId` and emits timing requests.
- **No new vocabularies invented here.** All `emotion`/`gesture`/`posture`/camera enums remain owned by `packages/protocol`; this spec only *extends* them additively.
- **No GPU NVENC dependency.** The H100 finishing tier (SP-1 Tier-2) uses libx264; engine-three does not assume hardware encode.

### 1.4 Glossary

| Term | Definition |
|---|---|
| **Rundown** | The ordered list of `Section`s in a `NewsReportDoc.rundown` — the newsroom's running order for the broadcast, including blocks and ad-breaks. |
| **Section** | One story/segment (`Section`) with its own `storyForm`, `set`, `cameraDefault`, `lookOverride?`, `beats`, `graphics`, and `audio`. Sections may carry `block?`, `adBreakAfter?`, `softTime?`/`hardTime?`. |
| **Beat** | The atomic performance unit (`Beat`) inside a section: a line of `text` plus `emotion`, `gesture`, `posture`, optional `emphasis`/`prosody`/`sayAs`/`phoneme`, `pause_ms_after`, `camera?:CameraCue`, `transition?`, `gaze?`, `blocking?`, `lookOverride?`. A `Beat` is a strict superset of the `ScriptSegment` in `dsl.ts`. |
| **Story-form** | The journalistic template of a section (`READER`, `VO`, `VOSOT`, `PKG`, `LIVE`, `LOOK_LIVE`, `DONUT`, `MOS`, `STANDUP`, `KICKER`) that sets default blocking, graphics, and audio expectations. |
| **Sticky state** | Carry-forward semantics: camera, `look`, `set`, and background persist from beat to beat and section to section until a later beat/section overrides them — the Ren'Py-style behavior already in `compileManifest()`. |
| **Look** | The `PostProcessingSpec` (preset + effects: tone-mapping, bloom, LUT, grade, vignette, grain, sharpen, chromatic aberration, DoF, AO, AA) applied as a post `EffectComposer` pass on both backends (SP-2). Set at `NewsReportDoc.look`, overridable per `Section.lookOverride` and per `Beat.lookOverride`. |
| **Lowering** | The compile step that *lowers* the high-level `NewsReportDoc` into backend-specific forms: `ProjectDoc` + `Cue[]` for avatar-live, and `EngineRenderSpec`/`PerformanceManifest` for engine-three. |
| **Premium master** | The opt-in H100 finishing pass (SP-1 Tier-2): browser frames routed to `services/gpu/finishing` (GFPGAN → Real-ESRGAN ×4 → RIFE → libx264 CRF16 + AAC) for a higher-quality MP4 than the default in-browser WebCodecs export. |

### 1.5 Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ AUTHORING SURFACES (3, all → canonical JSON)                          │
│  (A) Canonical zod JSON   (B) .ncast screenplay text   (C) TS builder │
│      NewsReportDoc v2          (Fountain-like, parsed)      (fluent)   │
└───────────────┬───────────────────┬───────────────────┬──────────────┘
                │                    │ parse .ncast      │ .build()
                │                    ▼                   ▼
                │            ┌──────────────────────────────────┐
                └───────────►│  CANONICAL NewsReportDoc (v2)     │◄── LLM
                             │  packages/protocol (zod schema)   │   (director.ts
                             │  zod ──► JSON-Schema (wire/contract)│   system prompt)
                             └──────────────┬───────────────────┘
                                            │ validate (zod)
                                            ▼
                             ┌──────────────────────────────────┐
                             │  COMPILER / LOWERING              │
                             │  sticky carry-forward (cam/look/  │
                             │   set/bg) across beats + sections │
                             └───────┬───────────────────┬──────┘
                  ProjectDoc + Cue[] │                   │ EngineRenderSpec /
                                     ▼                   ▼ PerformanceManifest
            ┌────────────────────────────┐   ┌────────────────────────────────┐
            │ BACKEND 1: apps/avatar-live │   │ BACKEND 2: services/engine-three│
            │ (browser realtime studio)   │   │ (headless gl + Xvfb, H100 pod) │
            │ applyProject() fan-out:     │   │ compileManifest({scene}) →     │
            │  narration/avatar/camera/   │   │ setupEditorScene() w/ frozen   │
            │  lights/backScreen/headline │   │ camera; PostProcessingSpec pass│
            │ + Cue[] timeline tracks:    │   │                                │
            │  narration|camera|motion|   │   │ control-api → R2 work/{jobId}/ │
            │  audio                      │   │  manifest.json → POST /render  │
            │ EffectComposer (SP-2 look)  │   │ EffectComposer (SP-2 look)     │
            └─────────────┬──────────────┘   └────────────────┬───────────────┘
                          │ Record                              │ /render
                          ▼                                     ▼
            ┌────────────────────────────┐         ┌────────────────────────────┐
            │ SP-1 frame-exact export:    │         │ engine-three frame render   │
            │ Worker + OffscreenCanvas +  │         │ → finishing (premium master)│
            │ WebCodecs + Mediabunny mux  │         │ GFPGAN→ESRGAN×4→RIFE→x264   │
            │ avc1/hvc1, 6 formats, t=i/fps│        └────────────────┬───────────┘
            └─────────────┬──────────────┘                          │
                          ▼                                          ▼
                    ┌───────────────── MP4 (default) ──────── MP4 (premium) ┐
                    └───────────────────────────────────────────────────────┘
```

### 1.6 Reuse of `packages/protocol` + `ProjectDoc`

The DSL is built **additively** on top of two existing assets and never replaces them:

**`packages/protocol` (the contract layer).** `NewsReportDoc` is a new top-level type that *composes* the existing primitives rather than forking them. A `Beat` is a superset of `ScriptSegment` (`dsl.ts`): same `text`, `emotion`, `gesture`, `posture`, `emphasis`, `pause_ms_after`, `camera?:CameraCue` — extended with `sayAs`, `phoneme`, `prosody`, `transition`, `gaze`, `blocking`, `lookOverride`. The camera vocabulary (shots, moves, targets, easings) and the `emotion`/`gesture`/`posture` `z.enum`s remain the single source of truth; any extension is added there and re-exported via `npm run protocol:schema` so the Python GPU side stays in sync. The new `PostProcessingSpec` (`look`) is added to `scene.ts`'s `SceneDocument` and to `jobs.ts`'s `EngineRenderSpec`, then schema-regenerated. The director system prompt (`director.ts`) is extended to emit valid `NewsReportDoc`s by reading the same enums. Compilation to the GPU plane reuses `compileManifest()` and its sticky carry-forward logic verbatim.

**`apps/avatar-live`'s `ProjectDoc` (the editor layer).** The compiler lowers each `Section`/`Beat` into the existing `ProjectDoc` shape (`script`, `voiceId`, `rate`, `pitch`, `emotion`, `avatarUrl`, `shot`, `studioOn`, `idleMotion`, `headline`, `lights`, `backScreen`, `timeline`) plus a `Cue[]` timeline across the existing `narration | camera | motion | audio` tracks. The existing `applyProject()` fan-out then configures the whole editor unchanged. The existing import hook in `projectStore` (the `timelineFileEl` handler) is **extended additively** — its discriminator learns to recognize the new `NewsReportDoc` (and `.ncast`) alongside the legacy `ProjectDoc`, so older project files keep loading. Camera presets (`cam.*`), motion cues (`motion.*`), and lighting presets remain the building blocks the compiler targets. This keeps the new DSL a *superset authoring format* whose output is always expressible in the data the editor already consumes.

---

## 2. Canonical schema (`NewsReportDoc`) — full type reference

> **This section is AUTHORITATIVE.** Every later section, every `.ncast` parser rule, every fluent-builder method, and every compiler (→ `ProjectDoc`/`Cue[]` for avatar-live, → `EngineRenderSpec`/`PerformanceManifest` for engine-three) targets **exactly** these names. The definitions live in `packages/protocol` alongside the existing `dsl.ts`/`manifest.ts`/`scene.ts`/`jobs.ts`; they are **additive** — nothing here removes or renames existing `Script`/`ScriptSegment`/`CameraCue` types (see [§2.13 Backward compatibility](#213-backward-compatibility--zodjson-schema-export)).

All types are authored as **zod schemas** and the TypeScript types are `z.infer`-derived. Conventions used throughout:

- **Required** = field has no `.optional()` and no `.default()` — the doc is invalid without it.
- **Optional** = `.optional()` — may be absent; consumers must handle `undefined`.
- **Defaulted** = `.default(x)` — absent input is materialized to `x` by the compiler (so downstream always sees a value).
- All open string ids use `z.string().min(1)`; all enums are `z.enum([...])` (closed vocab — extend in `packages/protocol`, then `npm run protocol:schema`).
- All times are **seconds** (`number`, `float`) unless the field name ends in `_ms` (integer milliseconds). All durations are non-negative.
- **Sticky carry-forward** (Ren'Py-style) applies at compile time to `camera`, `look`, `set`, and back-screen across beats and sections: a value set in one beat/section persists until explicitly overridden. The schema marks these fields optional precisely because absence means "inherit".

### 2.1 Top level — `NewsReportDoc`

```ts
export const NewsReportDoc = z.object({
  version:  z.literal(2),                    // REQUIRED. Schema version discriminator. Always 2 for this DSL.
  meta:     Meta,                            // REQUIRED. Show-level metadata, anchors, fps, language.
  brandKit: BrandKit.optional(),             // OPTIONAL (Later). Channel-wide visual identity reused by graphics.
  look:     PostProcessingSpec.optional(),   // OPTIONAL (MVP). Show-level post FX; root of the look carry-forward chain.
  defaults: DocDefaults.optional(),          // OPTIONAL. Default beat/section values applied before sticky carry-forward.
  rundown:  z.array(Section).min(1),          // REQUIRED. Ordered newsroom rundown; ≥1 section. The performance.
});
export type NewsReportDoc = z.infer<typeof NewsReportDoc>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `version` | `2` (literal) | ✓ | — | Format discriminator; lets importers tell a v2 `NewsReportDoc` from a v1 `Script`/`ProjectDoc`. |
| `meta` | `Meta` | ✓ | — | Title, anchor roster, language, frame rate, aspect, captions. |
| `brandKit` | `BrandKit` | — | — | Palette/fonts/logo/lower-third style reused across all graphics (Later). |
| `look` | `PostProcessingSpec` | — | `'broadcast'` look at compile | Root post-processing. Sticky base for every `Section.lookOverride`/`Beat.lookOverride`. |
| `defaults` | `DocDefaults` | — | see §2.4 | Doc-wide fallbacks for emotion/gesture/posture/pause/camera so beats can be terse. |
| `rundown` | `Section[]` (≥1) | ✓ | — | The ordered list of sections that, performed in order, *is* the newscast. |

### 2.2 `Meta`

```ts
export const Meta = z.object({
  title:    z.string().min(1),                       // REQUIRED. Human title of the newscast.
  anchors:  z.array(Anchor).min(1),                  // REQUIRED. Roster; ≥1. Beats/sections reference by Anchor.id.
  language: z.string().min(2).default('en'),         // BCP-47 tag for TTS + captions. Default 'en'.
  fps:      z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30), // Master frame rate.
  aspect:   z.enum(['16:9', '9:16', '1:1']).default('16:9'), // Frame aspect; maps to capture format in §2.12.
  wpm:      z.number().min(60).max(300).default(130).optional(), // Default words-per-minute pace for WPM auto-timing (§5.4).
  captions: CaptionsSpec.optional(),                 // OPTIONAL (Later). Caption track config (608/708, dirty/clean).
});
export type Meta = z.infer<typeof Meta>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `title` | `string≥1` | ✓ | — | Show title; surfaced as default `headline`/project name in `ProjectDoc`. |
| `anchors` | `Anchor[]` (≥1) | ✓ | — | All presenters. Single-anchor MVP uses `anchors[0]`; multi-anchor is Later. |
| `language` | `string≥2` | — | `'en'` | BCP-47 language for TTS + caption locale. |
| `fps` | `24\|25\|30\|50\|60` | — | `30` | Master clock. Drives frame-exact render (`t = i/fps`, SP-1) and cue quantization. |
| `aspect` | `'16:9'\|'9:16'\|'1:1'` | — | `'16:9'` | Frame shape; resolved to a concrete capture resolution at render (§2.12). |
| `wpm` | `60–300` | — | `130` | Default broadcast read pace for pre-TTS WPM estimation (§5.4). V2 (preview pacing). |
| `captions` | `CaptionsSpec` | — | — | Burn-in/sidecar caption settings (Later). |

#### 2.2.1 `Anchor`

```ts
export const Anchor = z.object({
  id:        z.string().min(1),                 // REQUIRED. Stable id referenced by anchorId/gaze:'coAnchor'.
  name:      z.string().min(1),                 // REQUIRED. Display name (lower-third default, captions speaker).
  avatarUrl: z.string().url(),                  // REQUIRED. glTF/GLB avatar (ARKit/Oculus blendshapes or procedural).
  voiceId:   z.string().min(1),                 // REQUIRED. Cloned/preset voice id resolved by control-api.
  rate:      z.number().min(0.5).max(2).default(1),    // TTS speaking rate multiplier.
  pitch:     z.number().min(0.5).max(2).default(1),    // TTS pitch multiplier.
  homePose:  z.string().optional(),             // OPTIONAL. Camera-preset id for this anchor's default framing (e.g. 'cam.anchor').
});
export type Anchor = z.infer<typeof Anchor>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `id` | `string≥1` | ✓ | — | Referenced by `Section.anchorId`, `Beat.anchorId`, and `gaze:'coAnchor'` targeting. |
| `name` | `string≥1` | ✓ | — | Speaker label for lower-thirds and captions. |
| `avatarUrl` | `url` | ✓ | — | Avatar asset → `ProjectDoc.avatarUrl` / engine-three avatar node. |
| `voiceId` | `string≥1` | ✓ | — | → `ProjectDoc.voiceId`; resolved against D1/R2 cloned voices by control-api. |
| `rate` | `0.5–2` | — | `1` | → `ProjectDoc.rate`; per-anchor default, overridable per-beat via `prosody.rate`. |
| `pitch` | `0.5–2` | — | `1` | → `ProjectDoc.pitch`; overridable per-beat via `prosody.pitch`. |
| `homePose` | `string` | — | — | Camera preset id used as this anchor's resting shot when a section names them. |

### 2.3 `BrandKit` *(Later)*

```ts
export const RGBHex = z.string().regex(/^#([0-9a-fA-F]{6})$/);  // '#RRGGBB'

export const BrandKit = z.object({
  palette: z.object({
    primary:    RGBHex,                         // REQUIRED. Brand primary (lower-third fill, bug tint).
    secondary:  RGBHex,                         // REQUIRED. Brand secondary.
    accent:     RGBHex.default('#ffffff'),      // Highlight color.
    textOnDark: RGBHex.default('#ffffff'),      // Text color over dark graphics.
    textOnLight:RGBHex.default('#101418'),      // Text color over light graphics.
  }),
  fonts: z.object({
    display: z.string().default('Inter'),       // Headline/lower-third title font family.
    body:    z.string().default('Inter'),       // Body/subtitle/ticker font family.
  }).default({ display: 'Inter', body: 'Inter' }),
  logo:           z.object({ src: z.string().url(), corner: z.enum(['tl','tr','bl','br']).default('tr'), opacity: z.number().min(0).max(1).default(1) }).optional(),
  lowerThirdStyle:z.enum(['bar','box','minimal','gradient','ribbon']).default('bar'),  // Default lowerThird visual treatment.
  safeAreas:      z.object({ action: z.number().min(0).max(0.2).default(0.05), title: z.number().min(0).max(0.2).default(0.1) }).default({ action: 0.05, title: 0.1 }), // Inset fractions.
  musicBed:       AudioCue.optional(),          // OPTIONAL. Show-wide default music bed (a 'bed' AudioCue).
});
export type BrandKit = z.infer<typeof BrandKit>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `palette.primary/secondary` | `#RRGGBB` | ✓ | — | Core brand colors injected into graphic templates. |
| `palette.accent/textOnDark/textOnLight` | `#RRGGBB` | — | `#ffffff`/`#ffffff`/`#101418` | Secondary tints + auto text contrast. |
| `fonts.display/body` | `string` | — | `'Inter'` | Font families for graphics; loader resolves by name. |
| `logo` | `{src,corner,opacity}` | — | — | Persistent on-screen bug; `corner` ∈ `tl\|tr\|bl\|br`. |
| `lowerThirdStyle` | enum | — | `'bar'` | Default template for `Graphic{kind:'lowerThird'}` (`bar\|box\|minimal\|gradient\|ribbon`). |
| `safeAreas.action/title` | `0–0.2` | — | `0.05`/`0.1` | Edge-inset fractions for broadcast-safe graphic placement. |
| `musicBed` | `AudioCue` | — | — | Default show-long bed; per-section `audio` can override/duck it. |

> **Canonical note (reconciliation):** `BrandKit.palette` requires `primary` + `secondary`; the `accent/textOnDark/textOnLight` keys are defaulted. There is **no** `bg`/`text` palette key — graphics derive contrast text from `textOnDark`/`textOnLight`. `logo.corner` ∈ `tl|tr|bl|br` (not `top-right`). `lowerThirdStyle` is one of the five enum strings (not an object). Examples elsewhere in this spec conform to this shape.

### 2.4 `DocDefaults`

Doc-wide fallbacks applied **before** sticky carry-forward, so beats may omit common fields.

```ts
export const DocDefaults = z.object({
  emotion:        Emotion.default('neutral'),         // Default beat emotion.
  gesture:        Gesture.default('none'),            // Default beat gesture.
  posture:        Posture.default('neutral'),         // Default beat posture (V2 when wired in avatar-live).
  pause_ms_after: z.number().int().min(0).default(0), // Default trailing pause per beat (ms).
  camera:         CameraCue.optional(),               // Default opening camera if a section sets none.
  set:            SectionSet.optional(),              // Default opening set (mode + backScreen) for the sticky chain.
  idleMotion:     BodyClip.default('idle_calm'),      // Default body idle clip between talk clips.
  gaze:           Gaze.default('camera'),             // Default gaze target.
  lights:         Lighting.optional(),                // Optional explicit default lighting (overrides look→lights bridge).
  prosody:        Prosody.optional(),                 // Doc-wide default rate/pitch (→ ProjectDoc.rate/pitch).
}).default({});
export type DocDefaults = z.infer<typeof DocDefaults>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `emotion` | `Emotion` | — | `'neutral'` | Fallback when a beat omits `emotion`. |
| `gesture` | `Gesture` | — | `'none'` | Fallback gesture. |
| `posture` | `Posture` | — | `'neutral'` | Fallback posture (V2). |
| `pause_ms_after` | `int≥0` | — | `0` | Default inter-beat pause. |
| `camera` | `CameraCue` | — | — | Seed for the camera sticky chain if no section/beat sets one. |
| `set` | `SectionSet` | — | — | Seed for the set sticky chain. |
| `idleMotion` | `BodyClip` | — | `'idle_calm'` | Default rest clip. |
| `gaze` | `Gaze` | — | `'camera'` | Default eyeline. |
| `lights` | `Lighting` | — | — | Explicit default lighting; overrides the `look`→lighting bridge (§7.2.6). |
| `prosody` | `Prosody` | — | — | Doc-wide default rate/pitch. |

### 2.5 Shared vocab enums

These reuse the **existing** protocol vocab verbatim (extend only in `packages/protocol`). New-to-v2 enums are flagged. The full vocabulary with status/tier tagging lives in [§4](#4-complete-vocabulary-enums-existing-vs-new); this is the canonical TS surface.

```ts
// EXISTING (packages/protocol/dsl.ts) — unchanged.
export const Emotion = z.enum(['neutral','warm','happy','excited','serious','concerned','sad','confident','thoughtful','surprised']);
export const Gesture = z.enum(['none','wave','point','open_palms','count','thumbs_up','nod','shrug','hand_to_chest','explain']);
export const Posture = z.enum(['neutral','leaning_in','upright','relaxed','turned_slightly']);

// EXISTING camera vocab (dsl.ts CameraCue).
export const Shot   = z.enum(['wide','full','medium','medium_close','close_up','extreme_close_up']);
export const Move   = z.enum(['static','dolly_in','dolly_out','truck_left','truck_right','pan_left','pan_right','pedestal_up','pedestal_down','orbit_left','orbit_right']);
export const Target = z.enum(['eyes','face','chest','torso','full_body']);
export const Easing = z.enum(['linear','ease_in','ease_out','ease_in_out']);

// EXISTING body/face.
export const BodyClip = z.enum(['idle_calm','talk1','talk2','talk3','talk4','talk5']);

// NEW in v2.
export const Gaze       = z.enum(['camera','coAnchor','monitor']);                     // NEW. Eyeline target.
export const StoryForm  = z.enum(['READER','VO','VOSOT','PKG','LIVE','LOOK_LIVE','DONUT','MOS','STANDUP','KICKER']); // NEW (10). Rundown story templates.
export const SetMode    = z.enum(['real','chroma','virtual','LED','AR']);              // NEW. Studio environment kind.
export const Transition = z.enum(['cut','dissolve','fade','wipe','defocus']);          // NEW. Beat/section transition type.
```

> **Canonical note:** the `StoryForm` set is exactly **10** values: `READER, VO, VOSOT, PKG, LIVE, LOOK_LIVE, DONUT, MOS, STANDUP, KICKER`. (Early drafts listed `VOSOT` twice and mis-counted "11"; the de-duplicated canonical count is 10.)

### 2.6 `CameraCue` — extended

`CameraCue` is a **superset** of the existing `dsl.ts` `CameraCue` (`{shot,move,target,easing,intensity}`); all original fields keep their names and meanings. v2 adds preset binding + explicit pose so the editor camera presets (`cam.*`) and a frozen WYSIWYG pose can both be expressed.

```ts
export const Pose = z.tuple([z.number(),z.number(),z.number(),z.number(),z.number(),z.number(),z.number()]);
// [px,py,pz, tx,ty,tz, fov] — camera position, look-at target, vertical FOV (deg). Matches avatar-live Cue.pose.

export const CameraCue = z.object({
  // EXISTING fields (dsl.ts) — names/meanings unchanged:
  shot:      Shot.optional(),                          // Framing size.
  move:      Move.optional(),                          // Camera movement during the beat.
  target:    Target.optional(),                        // Subject focus point.
  easing:    Easing.default('ease_in_out'),            // Movement easing.
  intensity: z.number().min(0).max(1).default(0.5),    // Movement magnitude 0..1.
  // NEW in v2:
  preset:    z.enum(['cam.enterLeft','cam.wide','cam.anchor','cam.close','cam.screen','cam.orbit','cam.custom','cam.path','cam.screenSource']).optional(), // Bind to avatar-live preset catalog.
  pose:      Pose.optional(),                          // Explicit frozen pose (WYSIWYG editor camera). Wins over preset/shot.
  path:      z.array(Pose).min(2).optional(),          // Multi-keyframe dolly path (with preset 'cam.path').
  angle:     z.enum(['eye','low','high','dutch']).optional(),  // V2. Vertical/roll angle of the shot.
  focus:     z.object({ distance: z.number().min(0).optional(), bokeh: z.number().min(0).optional() }).optional(), // V2. Ties to look.dof.
  duration:  z.number().min(0).optional(),             // Move duration (s); defaults to the beat's spoken length.
});
export type CameraCue = z.infer<typeof CameraCue>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `shot` | `Shot` | — | inherit | Framing size; one of 6 shots. |
| `move` | `Move` | — | inherit (`'static'`) | One of 11 moves performed over the beat. |
| `target` | `Target` | — | inherit (`'face'`) | Focus point on the subject. |
| `easing` | `Easing` | — | `'ease_in_out'` | Interpolation curve for the move. |
| `intensity` | `0–1` | — | `0.5` | Move magnitude (e.g. dolly distance scale). |
| `preset` | `cam.*` enum | — | — | Resolve to an avatar-live head-relative preset pose. |
| `pose` | `Pose` (7-tuple) | — | — | Exact `[px,py,pz,tx,ty,tz,fov]`; **highest precedence** (frozen WYSIWYG camera). |
| `path` | `Pose[]` (≥2) | — | — | Keyframed camera path; paired with `preset:'cam.path'`. |
| `angle` | `eye\|low\|high\|dutch` | — | `eye` | V2. Vertical/roll angle; `dutch` rolls. |
| `focus` | `{distance?,bokeh?}` | — | — | V2. Per-beat DoF; feeds `look.effects.dof`. |
| `duration` | `s≥0` | — | beat length | Length of the move; omitted ⇒ matches spoken duration. |

**Precedence when resolving a beat camera:** `pose` > `path` > `preset` > (`shot`+`move`+`target`+`intensity`). Sticky carry-forward fills any unset field from the prior beat, then the section `cameraDefault`, then `DocDefaults.camera`.

### 2.7 `Section`

```ts
export const SectionSet = z.object({
  mode:       SetMode.default('virtual'),           // Studio environment kind.
  backScreen: BackScreen.optional(),                // Back-wall content (video/image/color/none).
});

export const Section = z.object({
  id:           z.string().min(1),                    // REQUIRED. Stable section id.
  slug:         z.string().min(1),                    // REQUIRED. Short rundown slug (e.g. 'OPEN', 'WX', 'KICKER').
  storyForm:    StoryForm,                             // REQUIRED. Story template driving graphics/structure.
  block:        z.enum(['A','B','C','D']).optional(), // OPTIONAL. Rundown block label for ad-break grouping.
  adBreakAfter: z.union([z.boolean(), AdBreak]).default(false), // bool marker (MVP) or full AdBreak (Later).
  softTime:     z.number().min(0).optional(),         // OPTIONAL. Target backtime (s from show start) — advisory pacing.
  hardTime:     z.number().min(0).optional(),         // OPTIONAL. Immovable offset (s); see §5.4.
  hardOut:      z.boolean().default(false),           // OPTIONAL. Section MUST END at hardTime (hard-out).
  timeFit:      TimeFit.optional(),                   // OPTIONAL. kill/float/pad directives for reconciliation (§5.4.5).
  wpm:          z.number().min(60).max(300).optional(),// OPTIONAL. Section read pace override (§5.4).
  anchorId:     z.string().optional(),                // OPTIONAL. Presenting anchor (defaults to meta.anchors[0].id).
  set:          SectionSet.default({ mode: 'virtual' }), // Set carries forward if a later section omits it.
  cameraDefault:CameraCue.optional(),                 // OPTIONAL. Section opening camera; seeds beat camera chain.
  lookOverride: PostProcessingSpec.partial().optional(), // OPTIONAL. Per-section look diff over doc look.
  reset:        z.array(Channel).optional(),          // OPTIONAL. Sticky channels to reset on section entry (§5.5.3).
  suppressAutoGraphics: z.boolean().default(false),   // OPTIONAL. Disable story-form auto-graphics (§5.3.1).
  beats:        z.array(Beat).min(1),                 // REQUIRED.* Ordered performance beats; ≥1 (see empty-section rule).
  graphics:     z.array(Graphic).default([]),         // Section-scoped graphics (lower-thirds, OTS, ticker…).
  audio:        z.array(AudioCue).default([]),        // Section-scoped audio (nat pops, sfx, bed overrides).
});
export type Section = z.infer<typeof Section>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `id` | `string≥1` | ✓ | — | Stable identity for cross-refs/diffing. |
| `slug` | `string≥1` | ✓ | — | Rundown shorthand shown in the editor section list. |
| `storyForm` | `StoryForm` | ✓ | — | Story template (READER/VO/PKG/…) selecting structure + default graphics. |
| `block` | `A\|B\|C\|D` | — | by position (§5.2) | Rundown block used to group around ad breaks. |
| `adBreakAfter` | `boolean \| AdBreak` | — | `false` | Marks an ad break after this section. MVP = bool marker; full `AdBreak` (Later). |
| `softTime` | `s≥0` | — | — | Advisory backtime target for pacing readouts (§5.4). |
| `hardTime` | `s≥0` | — | — | Immovable offset; section scheduled to begin (or end if `hardOut`) here. |
| `hardOut` | `boolean` | — | `false` | If true, section must **end** at `hardTime`. |
| `timeFit` | `TimeFit` | — | — | Overrun reconciliation directives (priority/kill/float/pad). |
| `wpm` | `60–300` | — | inherit `meta.wpm` | Section-level read pace. |
| `anchorId` | `string` | — | `meta.anchors[0].id` | Which anchor presents this section. |
| `set.mode` | `SetMode` | — | `'virtual'` | Environment kind; sticky across sections. |
| `set.backScreen` | `BackScreen` | — | inherit | Back-wall media; sticky across sections. |
| `cameraDefault` | `CameraCue` | — | inherit | Section's opening framing; seeds the beat camera chain. |
| `lookOverride` | `PostProcessingSpec` (partial) | — | inherit | Section-level look diff merged over the doc `look` (scoped — reverts at section end). |
| `reset` | `Channel[]` | — | — | Sticky channels reset on section entry. |
| `suppressAutoGraphics` | `boolean` | — | `false` | Suppress story-form auto-graphics. |
| `beats` | `Beat[]` (≥1) | ✓* | — | The spoken/performed content. Empty allowed only for `LIVE` placeholders / bumper-only sections (§5.1). |
| `graphics` | `Graphic[]` | — | `[]` | Graphics scoped to this section. |
| `audio` | `AudioCue[]` | — | `[]` | Audio cues scoped to this section. |

#### 2.7.1 `BackScreen`

Mirrors avatar-live `ProjectDoc.backScreen` (`{kind,src}|null`) and extends it.

```ts
export const BackScreen = z.object({
  kind: z.enum(['none','color','image','video','stream','chart']),   // Content type on the back wall / virtual screen.
  src:  z.string().optional(),                                        // URL (image/video/stream) or '#RRGGBB' (color); omit for 'none'.
  fit:  z.enum(['cover','contain','stretch']).default('cover'),       // How src maps onto the screen surface.
  loop: z.boolean().default(true),                                    // Loop video/stream sources.
  mute: z.boolean().default(true),                                    // Mute back-screen video audio (use AudioCue instead).
});
export type BackScreen = z.infer<typeof BackScreen>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `kind` | enum | ✓ | — | `none\|color\|image\|video\|stream\|chart` back-wall content. |
| `src` | `string` | — | — | URL or hex; required for all kinds except `none`. |
| `fit` | `cover\|contain\|stretch` | — | `'cover'` | Surface mapping. |
| `loop` | `boolean` | — | `true` | Loop time-based sources. |
| `mute` | `boolean` | — | `true` | Mute embedded audio (mix via `AudioCue`). |

> **Canonical note (reconciliation):** `BackScreen.kind` is exactly `none|color|image|video|stream|chart`. There is **no** `cast`/`url`/`source` kind. A live remote source is `kind:'stream'` (Later). Examples elsewhere conform.

### 2.8 `Beat`

The performance unit. A `Beat` is a **strict superset** of the existing `ScriptSegment` (`{seq,turnId?,text,emotion,gesture,posture,emphasis[],pause_ms_after,camera?}`): every `ScriptSegment` field is present with the same name/meaning, so an existing `Script` lowers into beats 1:1.

```ts
export const Emphasis = z.object({
  text:  z.string().min(1),                            // Substring of beat.text to emphasize.
  level: z.enum(['reduced','moderate','strong']).default('moderate'), // SSML-ish emphasis strength (V2: leveled).
});

export const Prosody = z.object({
  rate:  z.number().min(0.5).max(2).optional(),        // Per-beat rate multiplier over anchor.rate.
  pitch: z.number().min(0.5).max(2).optional(),        // Per-beat pitch multiplier over anchor.pitch.
  volume:z.number().min(0).max(1).optional(),          // Per-beat voice gain.
});

export const Blocking = z.object({
  position:   z.tuple([z.number(),z.number(),z.number()]).optional(), // World position → setPosition().
  turn:       z.number().min(-Math.PI).max(Math.PI).optional(),       // Body yaw (rad) → setTurn().
  headTilt:   z.number().min(-0.6).max(0.6).optional(),               // Head tilt/nod (rad) — NEW avatarController gap.
  mark:       z.string().optional(),                                  // Named stage position resolved from the set.
  idleMotion: BodyClip.optional(),                                    // Override idle clip this beat.
  speaker:    z.string().optional(),                                  // Mid-section anchor switch (multi-anchor = Later).
});

export const Beat = z.object({
  // EXISTING ScriptSegment fields — names/meanings unchanged:
  id:             z.string().min(1),                   // REQUIRED (was implicit seq). Stable beat id.
  seq:            z.number().int().min(0).optional(),  // OPTIONAL. Original sequence index (back-compat).
  turnId:         z.string().optional(),               // OPTIONAL. Conversational turn grouping.
  text:           z.string(),                          // REQUIRED. Spoken narration (may be '' for silent action beats).
  emotion:        Emotion.optional(),                  // Emotion (inherits DocDefaults/sticky if omitted).
  gesture:        Gesture.optional(),                  // Gesture (NON-sticky — resets each beat).
  posture:        Posture.optional(),                  // Posture (V2 in avatar-live; sticky).
  emphasis:       z.array(Emphasis).default([]),       // Words/phrases to stress.
  pause_ms_after: z.number().int().min(0).optional(),  // Trailing pause (ms); inherits DocDefaults if omitted.
  camera:         CameraCue.optional(),                // Per-beat camera (sticky carry-forward).
  // NEW in v2:
  anchorId:       z.string().optional(),               // Per-beat speaking anchor (multi-anchor = Later).
  sayAs:          z.array(z.object({ text: z.string().min(1), as: z.enum(['date','time','number','ordinal','telephone','currency','spell','address']) })).default([]), // SSML say-as hints (V2).
  phoneme:        z.array(z.object({ text: z.string().min(1), ipa: z.string().min(1) })).default([]),  // IPA pronunciation overrides (V2).
  prosody:        Prosody.optional(),                  // Per-beat rate/pitch/volume (V2).
  gaze:           Gaze.optional(),                     // Eyeline this beat (inherits DocDefaults; sticky).
  transition:     z.object({ type: Transition, dur: z.number().min(0).default(0.5) }).optional(), // Transition OUT of this beat (V2).
  lookOverride:   PostProcessingSpec.partial().optional(), // Per-beat look diff (scoped — reverts next beat).
  reset:          z.array(Channel).optional(),         // Sticky channels to reset before this beat (§5.5.3).
  blocking:       Blocking.optional(),                 // OPTIONAL. Avatar staging this beat (sticky).
  note:           z.string().optional(),               // Director note — NEVER spoken/rendered ([[ ]] in .ncast).
  omit:           z.boolean().default(false),          // Boneyard: parsed & validated, NOT compiled (/* */ in .ncast).
});
export type Beat = z.infer<typeof Beat>;
```

| Field | Type | Req | Default | Sticky? | Semantics |
|---|---|---|---|---|---|
| `id` | `string≥1` | ✓ | — | — | Stable beat id; cue ids derive from it. |
| `seq` | `int≥0` | — | array index | — | Legacy sequence number for `ScriptSegment` round-trip. |
| `turnId` | `string` | — | — | — | Groups beats into a conversational turn. |
| `text` | `string` | ✓ | — | — | Narration; `''` allowed for a silent action/camera-only beat. |
| `emotion` | `Emotion` | — | inherit | ✅ (re-seeded per section) | Performed emotion (cross-fades — NEW controller gap). |
| `gesture` | `Gesture` | — | `'none'` | ❌ per-beat | Performed gesture (one-shot). |
| `posture` | `Posture` | — | inherit | ✅ | Body posture (V2 in avatar-live). |
| `emphasis` | `Emphasis[]` | — | `[]` | ❌ | Stressed substrings: `{text, level}`, level ∈ `reduced\|moderate\|strong`. |
| `pause_ms_after` | `int≥0` | — | inherit | ❌ | Trailing silence after the beat. |
| `camera` | `CameraCue` | — | inherit | ✅ (field-wise merge) | Beat camera; precedence per §2.6. |
| `anchorId` | `string` | — | section/meta | ❌ | Per-beat speaking anchor (Later for true multi-anchor). |
| `sayAs` | `{text,as}[]` | — | `[]` | ❌ | SSML say-as normalization hints (V2). |
| `phoneme` | `{text,ipa}[]` | — | `[]` | ❌ | IPA pronunciation overrides (V2). |
| `prosody` | `Prosody` | — | — | ❌ | Per-beat rate/pitch/volume over the anchor (V2). |
| `gaze` | `Gaze` | — | inherit | ✅ | Eyeline (`camera\|coAnchor\|monitor`) — NEW gaze-target gap. |
| `transition` | `{type,dur}` | — | — | ❌ | Transition *out of* this beat (V2); `type` ∈ §2.5 `Transition`. |
| `lookOverride` | `PostProcessingSpec` (partial) | — | inherit | scoped (reverts) | Per-beat look diff. |
| `reset` | `Channel[]` | — | — | — | Sticky channels reset before this beat. |
| `blocking.position` | `[x,y,z]` | — | — | ✅ | Avatar world position → `setPosition()`. |
| `blocking.turn` | `−π..π` | — | — | ✅ | Body yaw → `setTurn()`. |
| `blocking.headTilt` | `−0.6..0.6` | — | — | ✅ | Head tilt/nod (rad) — NEW `avatarController` capability. |
| `blocking.mark` | `string` | — | — | ✅ | Named stage position. |
| `blocking.idleMotion` | `BodyClip` | — | inherit | ✅ | Idle clip override for this beat. |
| `note` | `string` | — | — | — | Director note (non-rendering). |
| `omit` | `boolean` | — | `false` | — | Boneyard: validated but not compiled. |

> **Canonical note (reconciliation):** `Emphasis` is `{text, level}` with `level ∈ reduced|moderate|strong`; the screenplay `*…*`/`**…**` sugar maps onto these levels. There is **no** `phrase` key and **no** `light` level — `*…*` maps to `moderate`, `**…**` (or `*…!*`) to `strong`. `sayAs` entries are `{text, as}` with `as ∈ date|time|number|ordinal|telephone|currency|spell|address` — there is **no** `phrase`/`interpretAs` key. Examples elsewhere in this spec conform. `transition` is a transition *out of* the beat (crossing into whatever renders next).

### 2.9 `Graphic` — discriminated union

Discriminated on `kind`. Common fields appear on every member; kind-specific fields follow. `at`/`out` are **section-relative** seconds; omitted `at` ⇒ section start, omitted `out` ⇒ section end.

```ts
const GraphicBase = {
  id:   z.string().min(1),                              // REQUIRED. Stable graphic id.
  at:   z.number().min(0).optional(),                   // In-point (s, section-relative). Default: section start.
  out:  z.number().min(0).optional(),                   // Out-point (s, section-relative). Default: section end.
  anim: z.enum(['none','fade','slide','slideUp','wipe','pop']).default('fade'), // In/out animation.
  layer:z.number().int().min(0).max(100).default(10),   // Z-order; higher = front.
};

export const Graphic = z.discriminatedUnion('kind', [
  z.object({ ...GraphicBase, kind: z.literal('lowerThird'),
    title: z.string().min(1), subtitle: z.string().optional(), style: z.enum(['bar','box','minimal','gradient','ribbon']).optional() }), // Name/title strap.
  z.object({ ...GraphicBase, kind: z.literal('fullscreen'),
    src: z.string().url(), caption: z.string().optional(), fit: z.enum(['cover','contain']).default('cover') }), // Full-frame still/graphic.
  z.object({ ...GraphicBase, kind: z.literal('OTS'),
    src: z.string().url(), label: z.string().optional(), side: z.enum(['left','right']).default('right') }),     // Over-the-shoulder box.
  z.object({ ...GraphicBase, kind: z.literal('ticker'),
    items: z.array(z.string().min(1)).min(1), speed: z.number().min(0).default(60), position: z.enum(['top','bottom']).default('bottom') }), // Scrolling crawl.
  z.object({ ...GraphicBase, kind: z.literal('bug'),
    src: z.string().url(), corner: z.enum(['tl','tr','bl','br']).default('tr'), opacity: z.number().min(0).max(1).default(1) }),            // Persistent channel bug.
  z.object({ ...GraphicBase, kind: z.literal('still'),
    src: z.string().url(), x: z.number().default(0.5), y: z.number().default(0.5), scale: z.number().min(0).default(1) }),                  // Free-placed still.
  z.object({ ...GraphicBase, kind: z.literal('chart'),
    chartType: z.enum(['bar','line','pie','donut','area']), data: z.array(z.object({ label: z.string(), value: z.number() })).min(1), title: z.string().optional() }), // Data chart.
  z.object({ ...GraphicBase, kind: z.literal('map'),
    center: z.tuple([z.number(),z.number()]), zoom: z.number().min(0).max(22).default(6), markers: z.array(z.object({ lat: z.number(), lon: z.number(), label: z.string().optional() })).default([]) }), // Map.
  z.object({ ...GraphicBase, kind: z.literal('bumper'),
    src: z.string().url(), audioSrc: z.string().url().optional() }),                                                                        // Section bumper/sting.
]);
export type Graphic = z.infer<typeof Graphic>;
```

| `kind` | Tier | Distinct fields | Semantics |
|---|---|---|---|
| `lowerThird` | V2 | `title`, `subtitle?`, `style?` | Speaker/topic strap; `style` overrides `brandKit.lowerThirdStyle`. |
| `fullscreen` | MVP | `src`, `caption?`, `fit` | Full-frame image/graphic with optional caption (VO carrier). |
| `OTS` | Later | `src`, `label?`, `side` | Over-the-shoulder box beside the anchor. |
| `ticker` | V2 | `items[]`, `speed`, `position` | Scrolling headline crawl; `speed` px/s. |
| `bug` | V2 | `src`, `corner`, `opacity` | Persistent logo bug. |
| `still` | MVP | `src`, `x`, `y`, `scale` | Free-placed still (normalized 0..1 coords). |
| `chart` | Later | `chartType`, `data[]`, `title?` | Rendered data chart. |
| `map` | Later | `center`, `zoom`, `markers[]` | Geographic map with markers. |
| `bumper` | V2 | `src`, `audioSrc?` | Section sting/bumper clip (also emitted by ad-breaks). |

Common fields (all kinds): `id` (req), `at?`, `out?`, `anim` (`none\|fade\|slide\|slideUp\|wipe\|pop`, def `fade`), `layer` (`0–100`, def `10`).

> **Canonical note (reconciliation):** `lowerThird` uses `{title, subtitle, style}` (not `{name, title, line2}`). `anim` includes `slideUp` (used by lower-thirds) alongside `none|fade|slide|wipe|pop`. Examples elsewhere conform.

### 2.10 `AudioCue`

Mirrors avatar-live `Cue{track:'audio'}` fields (`src,volume,fadeIn,fadeOut`) and adds broadcast audio kinds + ducking. Times are **section-relative** seconds.

```ts
export const AudioCue = z.object({
  id:       z.string().min(1),                          // REQUIRED. Stable audio cue id.
  kind:     z.enum(['bed','sfx','natpop','sot']),       // REQUIRED. bed=music, sfx=effect, natpop=nat sound, sot=sound-on-tape.
  src:      z.string(),                                 // REQUIRED. Audio asset URL.
  start:    z.number().min(0).default(0),               // In-point (s, section-relative).
  duration: z.number().min(0).optional(),               // Play length (s); omit ⇒ until section end / clip end.
  volume:   z.number().min(0).max(1).default(0.8),      // Gain 0..1.
  fadeIn:   z.number().min(0).default(0),               // Fade-in (s).
  fadeOut:  z.number().min(0).default(0),               // Fade-out (s).
  loop:     z.boolean().default(false),                 // Loop for the duration (beds).
  outcue:   z.boolean().default(false),                 // Marks the line the package ends on (PKG/VOSOT).
  duck:     z.object({ target: z.literal('voice'), amount: z.number().min(0).max(1).default(0.6) }).optional(), // Sidechain duck under voice (V2).
});
export type AudioCue = z.infer<typeof AudioCue>;
```

| Field | Type | Req | Default | Semantics |
|---|---|---|---|---|
| `id` | `string≥1` | ✓ | — | Stable cue id. |
| `kind` | `bed\|sfx\|natpop\|sot` | ✓ | — | Music bed / one-shot sfx / nat-sound pop / sound-on-tape clip. |
| `src` | `string` | ✓ | — | Audio asset URL → Web-Audio buffer (SP-1 mix). |
| `start` | `s≥0` | — | `0` | Section-relative in-point. |
| `duration` | `s≥0` | — | — | Length; omit = play to natural/section end. |
| `volume` | `0–1` | — | `0.8` | Gain. |
| `fadeIn`/`fadeOut` | `s≥0` | — | `0`/`0` | Envelope ramps. |
| `loop` | `boolean` | — | `false` | Loop (typical for `bed`). |
| `outcue` | `boolean` | — | `false` | Marks package end (PKG/VOSOT). |
| `duck` | `{target:'voice',amount}` | — | — | Duck this cue under the voice bus by `amount` (V2). |

> **Canonical note:** `AudioCue.kind` is `bed|sfx|natpop|sot`. `sot` (sound-on-tape) + `outcue` support the package sub-grammar (§6.1.8); `sot`/`natpop` clip time handling is Later. The only legal `duck.target` is `voice`.

### 2.11 `PostProcessingSpec` (the `look`)

Authored once here, added to `packages/protocol` `scene.ts` **and** referenced by `EngineRenderSpec` (jobs.ts). Drives SP-2 (pmndrs `postprocessing` `EffectComposer`). `preset` chooses a baseline; `effects` is a shallow override applied on top. `lookOverride` on sections/beats uses `PostProcessingSpec.partial()`.

```ts
export const PostProcessingSpec = z.object({
  preset: z.enum(['none','broadcast','cinematic','warm','cool','neutral-agx','noir']).default('broadcast'), // Baseline look.
  effects: z.object({
    toneMapping: z.object({ operator: z.enum(['none','linear','reinhard','cineon','aces','agx']).default('aces'), exposure: z.number().min(0).max(4).default(1.05) }).default({}), // HDR→LDR. AgX needs three r160 (note in SP-2).
    bloom:   z.object({ intensity: z.number().min(0).max(3).default(0.3), threshold: z.number().min(0).max(1).default(0.85), radius: z.number().min(0).max(1).default(0.4) }).default({}), // HDR bloom.
    lut:     z.object({ url: z.string().url(), intensity: z.number().min(0).max(1).default(1) }).optional(),                 // .cube LUT (LDR).
    grade:   z.object({ contrast: z.number().min(-1).max(2).default(0), saturation: z.number().min(-1).max(2).default(0), temperature: z.number().min(-1).max(1).default(0), tint: z.number().min(-1).max(1).default(0), exposure: z.number().min(-2).max(2).default(0) }).default({}), // Color grade (LDR).
    vignette:z.object({ darkness: z.number().min(0).max(1).default(0.3), offset: z.number().min(0).max(1).default(0.5) }).default({}),  // Edge darkening.
    grain:   z.object({ intensity: z.number().min(0).max(1).default(0.04) }).default({}),                                   // Film grain (seeded per frame index for determinism).
    sharpen: z.object({ amount: z.number().min(0).max(1).default(0.2) }).default({}),                                       // Unsharp mask.
    chromaticAberration: z.object({ offset: z.number().min(0).max(0.01).default(0) }).default({}),                          // RGB split.
    dof:     z.object({ focusDistance: z.number().min(0).default(0), bokehScale: z.number().min(0).max(10).default(0) }).optional(), // Depth of field (HDR).
    motionBlur: z.object({ intensity: z.number().min(0).max(1).default(0) }).optional(),                                    // Motion blur (HDR; Later).
    ao:      z.object({ intensity: z.number().min(0).max(2).default(0) }).default({}),                                      // Ambient occlusion.
    aa:      z.enum(['smaa','msaa','none']).default('smaa'),                                                                // Anti-aliasing (SMAA last in chain).
  }).default({}),
});
export type PostProcessingSpec = z.infer<typeof PostProcessingSpec>;
```

| Group | Field | Range | Default | Semantics |
|---|---|---|---|---|
| `preset` | — | `none\|broadcast\|cinematic\|warm\|cool\|neutral-agx\|noir` | `'broadcast'` | Baseline look; `effects` overrides on top. |
| `toneMapping` | `operator` | `none\|linear\|reinhard\|cineon\|aces\|agx` | `'aces'` | HDR→LDR operator. `renderer` set `NoToneMapping`; library tonemaps (SP-2). |
| | `exposure` | `0–4` | `1.05` | Tone-map exposure. |
| `bloom` | `intensity/threshold/radius` | `0–3`/`0–1`/`0–1` | `0.3`/`0.85`/`0.4` | HDR bloom (before tonemap). |
| `lut` | `url`,`intensity` | url / `0–1` | — / `1` | `.cube` LUT applied in LDR. |
| `grade` | `contrast/saturation` | `−1..2` | `0` | LDR color grade (1.0 = neutral when authored as a multiplier; 0 = neutral when authored as a delta — see note). |
| | `temperature/tint` | `−1..1` | `0` | White-balance shift. |
| | `exposure` | `−2..2` | `0` | Post-tonemap exposure trim. |
| `vignette` | `darkness/offset` | `0–1` | `0.3`/`0.5` | Edge darkening. |
| `grain` | `intensity` | `0–1` | `0.04` | Film grain (seeded). |
| `sharpen` | `amount` | `0–1` | `0.2` | Unsharp mask. |
| `chromaticAberration` | `offset` | `0–0.01` | `0` | RGB split. |
| `dof` | `focusDistance/bokehScale` | `0+`/`0–10` | — | Depth of field (HDR; opt-in). |
| `motionBlur` | `intensity` | `0–1` | — | Motion blur (HDR; Later). |
| `ao` | `intensity` | `0–2` | `0` | Ambient occlusion. |
| `aa` | — | `smaa\|msaa\|none` | `'smaa'` | Anti-aliasing; SMAA applied last per SP-2 chain order. |

> **Grade convention:** `contrast`/`saturation` accept a `−1..2` range so authors may express either a small delta (`0` = neutral, e.g. `+0.02`) or a multiplier-style value (`1.0` = neutral, e.g. `1.02`). The compiler normalizes: values near `0` are treated as deltas, values near `1` as multipliers. Worked examples use the multiplier form (`contrast: 1.02`) for clarity. Both are valid against the schema.

**Pipeline order (SP-2):** `scene → [HalfFloat] → (AO / DoF / MotionBlur / Bloom) → ToneMapping → LUT/grade → ChromaticAberration → Vignette → Grain → Sharpen → SMAA`. HDR effects precede `toneMapping`; LDR effects follow. The `'broadcast'` default materializes to: subtle bloom `(0.3, thr 0.85)` → ACES `exp 1.05` → neutral LUT → gentle grade → subtle vignette → low grain `(0.04)` → mild sharpen → SMAA. Full pipeline detail in [§8.2](#82-sp-2--camera-filters--look-post-processing).

### 2.12 `CaptionsSpec` *(Later)* + aspect→capture-format mapping

```ts
export const CaptionsSpec = z.object({
  enabled:  z.boolean().default(false),                 // Emit a caption track.
  mode:     z.enum(['burnedIn','sidecar','both']).default('sidecar'), // Render path for captions.
  standard: z.enum(['608','708','webvtt','srt']).default('webvtt'),   // Caption standard.
  cleanFeed:z.boolean().default(true),                  // Also produce a clean (caption-free) master.
});
export type CaptionsSpec = z.infer<typeof CaptionsSpec>;
```

> **Canonical note (reconciliation):** `CaptionsSpec` is `{enabled, mode, standard, cleanFeed}`. The `608`/`708` values are the `standard` field (not a free-form `style`). Examples elsewhere conform.

`Meta.aspect` resolves to a concrete capture format (one of the 6 SP-1 formats) at render time per the requested resolution tier:

| `aspect` | Default resolution | 4K tier | Notes |
|---|---|---|---|
| `'16:9'` | `1920×1080` (1080p) | `3840×2160` (4K UHD) | Also supports 720p/1440p tiers. |
| `'9:16'` | `1080×1920` (vertical) | — | Vertical social. |
| `'1:1'` | `1080×1080` (square) | — | Square social. |

### 2.13 Backward compatibility + zod→JSON-Schema export

- **Additive only.** `NewsReportDoc` and its nested types are added to `packages/protocol`; the existing `Script`, `ScriptSegment`, `CameraCue`, `PerformanceManifest`, `SceneDocument`, `EngineRenderSpec`, and the `Emotion/Gesture/Posture/Shot/Move/Target/Easing/BodyClip` enums are **reused unchanged**. The v2 `CameraCue` here is the same exported symbol with optional `preset/pose/path/angle/focus/duration` added — every existing `CameraCue` literal stays valid (all new fields optional).
- **`Beat` ⊇ `ScriptSegment`.** Lowering a legacy `Script` to a `NewsReportDoc` is mechanical: wrap `segments` as one `READER` `Section`'s `beats`, mapping `seq→seq`, keeping `turnId/text/emotion/gesture/posture/emphasis/pause_ms_after/camera`, and synthesizing `id` from `seq`. The reverse (beats→segments) drops only v2-new fields. The avatar-live `projectStore` import discriminator keys on `version === 2` (NewsReportDoc) vs the existing `ProjectDoc`/v1 `Script` vs `.ncast` text.
- **`PostProcessingSpec` shared.** Added to `scene.ts` and embedded in `EngineRenderSpec` (jobs.ts) so the headless engine-three composer (SP-2) and the browser composer read one schema.
- **Schema generation.** All new schemas are exported from `packages/protocol/src/index.ts` and picked up by `npm run protocol:schema` (zod → JSON Schema), keeping the Python GPU side (`services/gpu`) and control-api in sync. Discriminated unions (`Graphic`) export as JSON-Schema `oneOf` keyed on `kind`; `z.literal(2)` for `version` exports as `const: 2`. Defaults are emitted into the JSON Schema so non-TS consumers materialize the same values.
- **Compile targets.** `compileNewsReport(doc)` lowers a validated `NewsReportDoc` to **(a)** avatar-live `ProjectDoc` + `Cue[]` (per-`Anchor`→`avatarUrl/voiceId/rate/pitch`; `Beat`→narration/motion `Cue`s; `CameraCue`→camera `Cue.pose/path`; `Graphic`/`AudioCue`→overlay/audio `Cue`s; `look`→applied composer config) and **(b)** engine-three `EngineRenderSpec`/`PerformanceManifest` via `compileManifest({ scene, look })` with sticky carry-forward preserved. Both targets receive the same materialized defaults, so browser preview and H100 master match. Full rules in [§7](#7-compile--lowering-rules--import--record-runtime-flow).

> **`Channel`, `AdBreak`, `TimeFit`, `Lighting` types** referenced above are defined in [§5](#5-rundown--timing-model) (timing model). `Channel = 'camera'|'look'|'set'|'lighting'|'music'|'emotion'|'posture'|'gaze'`.

---

## 3. The `.ncast` screenplay grammar + TS builder

This section defines the two **human-authoring surfaces** that compile to the same canonical `NewsReportDoc` (version 2) defined in §2: the **`.ncast` screenplay grammar** (a Fountain-derived plain-text format) and the **embedded-TS fluent builder**. Both are *lossless lowerings into* the canonical zod doc — anything expressible in `.ncast` or the builder maps onto a field defined in §2, and nothing else. The canonical JSON in `packages/protocol` remains the wire/contract format; `.ncast` and the builder are conveniences that produce it.

> Authoring-surface invariant: **`parseNcast(text) ⊨ NewsReportDoc` and `report(...).build() ⊨ NewsReportDoc`**, validated by the same zod schema. The compiler to `ProjectDoc`/`Cue[]` (avatar-live) and `EngineRenderSpec`/`PerformanceManifest` (engine-three) never sees `.ncast` or the builder — only the canonical doc. This keeps the three surfaces in lockstep.

### 3.1 Design principles

1. **Fountain-like, not Fountain.** We borrow Fountain's "plain text reads like a script" ethos (scene headings, dialogue, parentheticals, transitions, boneyard, notes) but **redefine the semantics** for a newsroom rundown. A `.ncast` file is *not* valid Fountain and is *not* meant to round-trip through Fountain tools.
2. **Every construct maps to exactly one canonical field.** No construct is decorative. §3.3–§3.10 give the exact mapping tables, all targeting §2 names.
3. **Sticky carry-forward is a parse-time concept too.** The grammar lets you *omit* camera/look/set/background; the compiler (not the parser) applies the §2/§5.5 sticky carry-forward. The parser emits only what was written, leaving unspecified fields `undefined` so carry-forward can fill them.
4. **Vocabulary is closed.** Emotions/gestures/postures/shots/moves/targets/easings/story-forms/transitions are the §4 enums. The parser **rejects** out-of-vocabulary tokens with a line-numbered diagnostic; it never silently coerces.
5. **Tiers.** Every construct is tagged MVP / V2 / Later. An MVP-only parser may parse-and-ignore V2/Later constructs (preserving them in a `raw` passthrough) so files remain forward-compatible.

> **Reconciliation note:** §3 and §9.2 illustrate two equivalent `.ncast` surface styles (a sigil-heavy form in §3, a directive-keyword form `::`/`@`/`SET`/`CAM`/`LOOK` in §9.2). Both are valid `.ncast` and both parse to the same `NewsReportDoc`. The grammar below is the normative reference; §9.2 is a worked example in the directive style. Either may be used; the parser accepts both.

### 3.2 Lexical structure (prose)

A `.ncast` file is UTF-8 text, parsed **line-oriented** with a small number of block constructs. Significant tokens:

| Sigil / form | Construct | Tier |
|---|---|---|
| `---` … `---` (file head) | YAML-ish **frontmatter** | MVP |
| `# ` / `## ` | **Section header** (block / sub-section) | MVP |
| `@NAME` at line start | **Anchor cue** (who speaks the following dialogue) | MVP |
| plain text line(s) | **Dialogue** = `Beat.text` (spoken) | MVP |
| `(…)` on its own line, before/within dialogue | **Parenthetical** = performance (emotion/gesture/posture/prosody/gaze) | MVP |
| `>> …` | **Camera line** | MVP |
| `> TYPE DUR >` | **Transition** | V2 |
| `{kind: …}` | **Graphic** (lower-third / fullscreen / OTS / ticker / bug / still / chart / map / bumper) | V2 (lowerThird/fullscreen/still MVP) |
| `~ kind: …` | **Audio cue** (bed / sfx / natpop / sot) | MVP (bed), V2 (sfx/duck) |
| `*word*` / `**word**` | **Emphasis** (moderate / strong) | MVP / V2 |
| `[sayAs:…]` / `[phoneme:…]` inline | **SSML span** | V2 |
| `[[ … ]]` | **Director note** (→ `Beat.note`; ignored by compiler) | MVP |
| `/* … */` | **Boneyard** (→ `Beat.omit`/discarded; ignored, may span lines) | MVP |
| `%% key: value` | **Set / block directive** (machine-readable inline attrs) | MVP |
| blank line | **Beat separator** within a section | MVP |

Parsing precedence per non-blank line, top to bottom: boneyard close → frontmatter fence → section header → transition → camera line → graphic → audio cue → set directive → anchor cue → parenthetical → director note (full-line) → dialogue. Inline tokens (`*…*`, `[[…]]`, `[sayAs]`, `[phoneme]`, `/* */`) are tokenized *within* a dialogue line.

### 3.3 Frontmatter → `meta` / `look` / `brandKit` / `defaults`

The file **may** open with a frontmatter block fenced by `---`. Keys are a closed set mapping 1:1 onto §2:

```ncast
---
title:    "Evening Edition — June 21"
language: en-US
fps:       30                     # default 30 if omitted
aspect:    "16:9"
captions:  { enabled: true, mode: sidecar, standard: 708, cleanFeed: true }   # V2; CaptionsSpec (§2.12)

anchors:
  - { id: maya,  name: "Maya Chen",   avatarUrl: "/avatars/maya.glb",  voiceId: "vx_maya"  }
  - { id: theo,  name: "Theo Park",   avatarUrl: "/avatars/theo.glb",  voiceId: "vx_theo"  }

look:                            # PostProcessingSpec (§2.11, SP-2)
  preset:  broadcast
  effects:
    bloom:       { intensity: 0.3, threshold: 0.85 }
    toneMapping: { operator: aces, exposure: 1.05 }    # 'aces' (lowercase enum), not 'ACES'
    grade:       { contrast: 1.02, saturation: 1.05, temperature: 0.0 }
    vignette:    { darkness: 0.25, offset: 0.6 }
    grain:       { intensity: 0.04 }
    sharpen:     { amount: 0.2 }
    aa:          smaa

brandKit:                        # Later (parsed, passthrough-stored if MVP); BrandKit (§2.3)
  palette:   { primary: "#0A2A6B", secondary: "#06133A", accent: "#EE1111" }
  fonts:     { display: "Inter", body: "Inter" }
  logo:      { src: "/brand/bug.png", corner: tr }
  lowerThirdStyle: bar           # one of bar|box|minimal|gradient|ribbon
  safeAreas: { action: 0.05, title: 0.1 }
  musicBed:  { id: bed_show, kind: bed, src: "/music/news-bed.mp3", volume: 0.18 }

defaults:                        # seed sticky carry-forward (§2.4 DocDefaults)
  emotion:  confident
  posture:  upright
  gaze:     camera
  camera:   { shot: medium, move: static, target: face, easing: ease_in_out, intensity: 0.5 }
  set:      { mode: virtual, backScreen: { kind: image, src: "/sets/newsroom.jpg" } }
---
```

**Exact mapping:**

| Frontmatter key | Canonical target (§2) |
|---|---|
| `title` | `meta.title` |
| `language` | `meta.language` |
| `fps` | `meta.fps` (default `30`) |
| `aspect` | `meta.aspect` |
| `captions` | `meta.captions: CaptionsSpec` (V2) — `{enabled, mode, standard, cleanFeed}` |
| `anchors[]` | `meta.anchors: Anchor[]` — each `{id,name,avatarUrl,voiceId}` |
| `look` | `look: PostProcessingSpec` — `preset` + `effects{toneMapping,bloom,lut,grade,vignette,grain,sharpen,chromaticAberration,dof,ao,aa}` |
| `brandKit` | `brandKit: BrandKit` (palette{primary,secondary,…}/fonts/logo{src,corner}/lowerThirdStyle/safeAreas/musicBed) |
| `defaults` | `defaults: DocDefaults` — seeds initial sticky state for camera/look/set/emotion/posture/gaze |

`defaults` is the *only* place a doc-wide initial camera/set/look is declared; per-beat and per-section values override it via carry-forward.

### 3.4 Section headers → `Section`

A section header opens a `Section`. `#` opens a **block-level section** (a rundown block, e.g. "A-block"); `##` opens a story within it. Both produce `Section` entries in the flat `rundown: Section[]`; the `block` field records the parent block label (one of `A|B|C|D`, §2.7) so the compiler can reconstruct rundown blocks and schedule `adBreakAfter`.

Grammar of a header line:

```
# A                                                (block divider — sets current block label, A|B|C|D)
## STORYFORM  "Slug Text"  [attr=val ...]          (a story section)
```

`STORYFORM` is one of the §4 enum: `READER | VO | VOSOT | PKG | LIVE | LOOK_LIVE | DONUT | MOS | STANDUP | KICKER`. Bracketed `[attr=val]` pairs are a closed set:

```ncast
# A
## READER "Mayor announces transit plan" [anchor=maya set=virtual cam=medium]
## PKG    "Flood recovery one year on"   [anchor=theo set=LED ad-break-after soft=120 hard=150]

# B
## VOSOT  "Markets close higher"          [anchor=maya gaze=monitor]
## KICKER "The penguin that moved town"   [anchor=theo set=chroma look=warm]
```

**Exact mapping (one header → one `Section`):**

| Header construct | Canonical field |
|---|---|
| `## STORYFORM` | `Section.storyForm` |
| `"Slug Text"` | `Section.slug` (kebab-cased) **and** seeds `Section.id` if no explicit `id=` |
| `# BLOCK` (most recent above; `A\|B\|C\|D`) | `Section.block` |
| `[anchor=ID]` | `Section.anchorId` |
| `[set=real\|chroma\|virtual\|LED\|AR]` | `Section.set.mode` |
| `[backScreen=kind:src]` or `%% backScreen:` directive | `Section.set.backScreen` |
| `[cam=SHOT]` (+ optional `move/target`) | `Section.cameraDefault: CameraCue` |
| `[look=PRESET]` or `%% look:` block | `Section.lookOverride: PostProcessingSpec` |
| `[ad-break-after]` | `Section.adBreakAfter = true` |
| `[soft=SEC]` / `[hard=SEC]` / `[hardOut]` | `Section.softTime` / `Section.hardTime` / `Section.hardOut` |
| `[id=…]` | `Section.id` (else derived from slug) |

A `# BLOCK` line on its own carries no story; it only **mutates the current block label** applied to subsequent `##` sections until the next `#`.

### 3.5 Anchors, dialogue, parentheticals → `Beat`

Within a section, the body is a sequence of **beats** separated by blank lines. The fundamental beat is **dialogue** (spoken text). An `@NAME` line preceding dialogue switches the speaking anchor for the rest of the section (or until another `@NAME`); it does **not** itself create a beat — it sets the active `anchorId`. In MVP the section's `anchorId` wins and a mid-section `@NAME` is recorded as `Beat.blocking.speaker` (multi-anchor two-shots are **Later**).

```ncast
## READER "Mayor announces transit plan" [anchor=maya cam=medium]

@MAYA
(warm, open_palms, upright)
Good evening. The city *unveiled* a sweeping transit overhaul today —
the largest in **a generation**.
>> MEDIUM_CLOSE dolly_in on face, ease_in_out 0.6
(serious)
Officials say the plan adds forty miles of rail. [[verify mileage w/ desk]]

(thoughtful) {pause 400}
But not everyone is convinced.
```

A **beat** is the run of dialogue lines bounded by blank lines, together with any parentheticals, camera lines, graphics, audio, transitions, and inline tokens attached to it. Mapping each construct onto the canonical `Beat` (§2.8):

| `.ncast` construct | `Beat` field | Notes / vocab |
|---|---|---|
| dialogue text lines (joined) | `Beat.text` | inline tokens stripped to plain text for TTS |
| `(emotion …)` first token | `Beat.emotion` | §4 Emotions(10) |
| `(…, gesture …)` token | `Beat.gesture` | §4 Gestures(10) |
| `(…, posture …)` token | `Beat.posture` | §4 Postures(5) |
| `(rate=… pitch=…)` token | `Beat.prosody {rate,pitch}` | V2 |
| `{pause N}` (ms) | `Beat.pause_ms_after` | int 0–5000 |
| `*word*` | `Beat.emphasis[]` entry, level `moderate` | MVP |
| `**word**` | `Beat.emphasis[]` entry, level `strong` | V2 (leveled emphasis) |
| `[sayAs:as "text"]` | `Beat.sayAs` span `{text, as}` | V2 (SSML); `as` ∈ §2.8 say-as enum |
| `[phoneme:ipa "text"]` | `Beat.phoneme` span `{text, ipa}` | V2 (SSML) |
| `>> …` (see §3.6) | `Beat.camera: CameraCue` | MVP |
| `> TYPE DUR >` (see §3.7) | `Beat.transition {type,dur}` | V2 |
| `(gaze camera\|coAnchor\|monitor)` | `Beat.gaze` | V2 |
| `(@pos … )` / `%% blocking:` | `Beat.blocking` | Later |
| `%% look: {…}` immediately under a beat | `Beat.lookOverride` | V2 |
| `[[ … ]]` | `Beat.note` | ignored by compiler |
| `/* … */` | discarded / `Beat.omit` | boneyard |

**Parenthetical grammar.** A parenthetical is a comma-separated list of tokens; the parser classifies each token by membership in the closed vocabularies (emotion/gesture/posture set) and by `key=value` form (`rate=`, `pitch=`, `gaze`). Order is free. Unknown bare tokens are a diagnostic. Multiple parentheticals in one beat **merge** (later wins per field), enabling `(warm)` then `(open_palms)` on separate lines.

**Emphasis tuple.** `*…*`/`**…**` produce `Beat.emphasis: Emphasis[]` where `Emphasis = { text, level: 'reduced'|'moderate'|'strong' }` (the §2.8 `Emphasis` type). `*…*` ⇒ `moderate`; `**…**` (or the `*…!*` shorthand used in §9.2) ⇒ `strong`. The matched word(s) are stripped of their sigils in `Beat.text`; the compiler maps `moderate→` prosodic stress and `strong→` stress + amplitude.

### 3.6 Camera lines → `Beat.camera` / `Section.cameraDefault`

A camera line begins with `>>` and uses exactly the §4 protocol camera vocabulary (uppercased shot names are accepted and lowered to the enum):

```
>> SHOT [MOVE] [on TARGET] [, EASING [INTENSITY]]
```

```ncast
>> CLOSE_UP                                   # shot only; move=static carry-forward
>> MEDIUM dolly_in on face                    # shot+move+target
>> WIDE truck_left on full_body, ease_out 0.8 # full form
>> on chest                                   # keep shot/move, retarget (carry-forward)
```

**Exact mapping → `CameraCue` (§2.6):**

| Token | Field | Enum (must match §4) |
|---|---|---|
| `SHOT` | `camera.shot` | `wide,full,medium,medium_close,close_up,extreme_close_up` |
| `MOVE` | `camera.move` | `static,dolly_in,dolly_out,truck_left,truck_right,pan_left,pan_right,pedestal_up,pedestal_down,orbit_left,orbit_right` |
| `on TARGET` | `camera.target` (default `face`) | `eyes,face,chest,torso,full_body` |
| `, EASING` | `camera.easing` (default `ease_in_out`) | `linear,ease_in,ease_out,ease_in_out` |
| trailing number | `camera.intensity` 0–1 (default `0.5`) | — |

> §9.2 uses the directive form `CAM SHOT MOVE TARGET EASING INTENSITY` (positional, no `>>`/`on`/comma). It is the same mapping. Both forms are accepted.

A `>>`/`CAM` line **attached to a beat** sets that `Beat.camera`. One **directly under a section header, before any dialogue** sets `Section.cameraDefault`. Omitted fields are left `undefined` so the §5.5 sticky carry-forward fills them from the prior beat → section default → doc `defaults`.

> Avatar-live compile note: each `Beat.camera` lowers to a `Cue { track:'camera', type, start, duration, pose? }`. The compiler maps `(shot,target)` to a head-relative preset key from the avatar-live catalog (`cam.wide/cam.anchor/cam.close/cam.screen/…`); `MOVE`+`intensity`+`easing` set the eased motion over `duration` (derived from the beat's audio length). engine-three lowers the same cue to its Sequencer camera (§7). Full reconciliation table in [§4.10](#410-camera-vocab-reconciliation-canonical--avatar-live--engine-three).

### 3.7 Transitions → `Beat.transition`

```
> TYPE DUR >          (sigil form)
>> TYPE DUR           (directive form, §9.2)
```

```ncast
> DISSOLVE 0.5 >
> CUT >
> WIPE 0.3 >
```

| Token | Field | Enum (§4) |
|---|---|---|
| `TYPE` | `transition.type` | `cut,dissolve,fade,wipe,defocus` |
| `DUR` (sec) | `transition.dur` | number; `cut` ignores it |

A transition line attaches to the beat it follows as its `transition` (a transition *out of* that beat, into the next unit). Tier: **V2** (`cut` is the implicit default and is MVP).

### 3.8 Graphics → `Section.graphics: Graphic[]`

Graphics use `{kind: …}` blocks (sigil) or `GFX/LT` directives (§9.2); fields after the kind are a closed per-kind set (§2.9). They attach to the **section** (added to `Section.graphics`), with `at`/`out` timing relative to the section start (or to the enclosing beat if placed inside one, in which case `at` defaults to the beat start).

```ncast
{lower-third: "Maya Chen" / "City Hall Reporter", at=0.5, out=4.0, anim=slideUp}   # V2 (lowerThird)
{fullscreen: "/gfx/transit-map.png", at=2.0, out=6.0, anim=fade}                   # MVP
{OTS: "/gfx/mayor.jpg", side=right}                                                # Later
{ticker: "Markets close higher", "Transit plan unveiled", speed=60}               # V2
{bug: "/brand/bug.png", corner=br}                                                 # V2
{still: "/gfx/skyline.jpg", at=0, out=3, scale=1}                                  # MVP
{chart: chartType=bar, data=[...], title="Daily ridership"}                        # Later
{map: center=[51.5,-0.12], zoom=12, markers=[...]}                                 # Later
{bumper: "/gfx/bblock.mp4"}                                                        # V2
```

**Exact mapping → `Graphic` (§2.9):** the leading token before `:` is `Graphic.kind` (`lowerThird|fullscreen|OTS|ticker|bug|still|chart|map|bumper` — note `lower-third` in text normalizes to `lowerThird`). `at`→`Graphic.at`, `out`→`Graphic.out`, `anim`→`Graphic.anim`. Remaining kind-specific keys populate the §2.9 kind-specific fields. For `lower-third`, the `"A" / "B"` shorthand maps to `{title:"A", subtitle:"B"}`.

### 3.9 Audio cues → `Section.audio: AudioCue[]`

```
~ KIND: SRC [, start=… duration=… volume=… fadeIn=… fadeOut=… duck=voice:AMOUNT]
```

```ncast
~ bed: "/music/news-bed.mp3", volume=0.18, fadeIn=1, fadeOut=2          # MVP
~ sfx: "/sfx/whoosh.wav", start=2.0, volume=0.6                          # V2
~ natpop: "/audio/crowd.wav", start=0, duration=4, duck=voice:0.5       # V2 (ducking)
~ sot: "/audio/interview.wav", start=0, outcue                          # V2 (package)
```

**Exact mapping → `AudioCue` (§2.10):** `KIND`→`AudioCue.kind` (`bed|sfx|natpop|sot`), `SRC`→`AudioCue.src`, plus `start,duration,volume,fadeIn,fadeOut`. `duck=voice:AMOUNT`→`AudioCue.duck {target:'voice', amount:AMOUNT}` (V2). `outcue`→`AudioCue.outcue=true`. A `~ bed:` in frontmatter (`brandKit.musicBed`) seeds a doc-wide bed; a section-level `~ bed:` overrides it for that section (sticky background carry-forward applies). The compiler assigns each cue a stable `id` if omitted.

> §9.2 uses `BED`/`AUD` directives — `BED src …` ≡ `~ bed: src …`; `AUD KIND src …` ≡ `~ KIND: src …`. Same mapping.

### 3.10 Notes, boneyard, directives

- `[[ … ]]` — **director note** → `Beat.note` (non-rendered annotation); **never** reaches the compiler output that drives the render.
- `/* … */` — **boneyard**; spans lines; discarded by the lexer before line classification (a whole boneyarded beat sets `Beat.omit:true` if it must survive for editor display).
- `%% key: value` / `%% key: { … }` — **machine directive** for fields awkward in shorthand (`%% set: {mode:LED, backScreen:{kind:video, src:"/sets/led.mp4"}}`, `%% look: {preset:cinematic}`, `%% blocking: {turn:0.3}`). Attaches to its enclosing scope (section if at section top, else current beat). This is the escape hatch that guarantees **every canonical field is reachable from `.ncast`** even before dedicated sugar exists.

### 3.11 Worked example → canonical JSON (abbreviated)

```ncast
---
title: "Evening Edition"
language: en-US
fps: 30
anchors: [ { id: maya, name: "Maya Chen", avatarUrl: "/a/maya.glb", voiceId: "vx_maya" } ]
look: { preset: broadcast }
defaults: { emotion: confident, posture: upright, camera: { shot: medium }, set: { mode: virtual } }
---

# A
## READER "Transit plan unveiled" [anchor=maya ad-break-after soft=90]
~ bed: "/music/bed.mp3", volume=0.15, fadeOut=2

@MAYA
(warm, open_palms)
Good evening. The city *unveiled* a sweeping transit plan today.
>> MEDIUM_CLOSE dolly_in on face, ease_in_out 0.6
{lower-third: "Maya Chen" / "Reporter", at=0.5, out=4}

(serious) {pause 400}
Officials say it adds **forty miles** of rail. [[verify w/ desk]]
```

compiles to (sticky carry-forward applied by the compiler, *not* the parser):

```jsonc
{
  "version": 2,
  "meta": { "title": "Evening Edition", "language": "en-US", "fps": 30,
            "anchors": [{ "id": "maya", "name": "Maya Chen", "avatarUrl": "/a/maya.glb", "voiceId": "vx_maya" }] },
  "look": { "preset": "broadcast", "effects": {} },
  "defaults": { "emotion": "confident", "posture": "upright",
                "camera": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.5 },
                "set": { "mode": "virtual" } },
  "rundown": [
    {
      "id": "transit-plan-unveiled", "slug": "transit-plan-unveiled",
      "storyForm": "READER", "block": "A", "anchorId": "maya",
      "adBreakAfter": true, "softTime": 90,
      "set": { "mode": "virtual" },
      "audio": [{ "id": "a1", "kind": "bed", "src": "/music/bed.mp3", "volume": 0.15, "fadeOut": 2 }],
      "graphics": [{ "id": "g1", "kind": "lowerThird", "title": "Maya Chen", "subtitle": "Reporter", "at": 0.5, "out": 4 }],
      "beats": [
        { "id": "b1", "text": "Good evening. The city unveiled a sweeping transit plan today.",
          "emotion": "warm", "gesture": "open_palms", "posture": "upright",
          "emphasis": [{ "text": "unveiled", "level": "moderate" }],
          "pause_ms_after": 0,
          "camera": { "shot": "medium_close", "move": "dolly_in", "target": "face", "easing": "ease_in_out", "intensity": 0.6 } },
        { "id": "b2", "text": "Officials say it adds forty miles of rail.",
          "emotion": "serious", "gesture": "open_palms", "posture": "upright",
          "emphasis": [{ "text": "forty miles", "level": "strong" }],
          "pause_ms_after": 400 }
      ]
    }
  ]
}
```

Note carry-forward: `b2` inherits `gesture=open_palms` (sticky? no — gesture is non-sticky, but here the resolver re-applies the section/`b1` value only if the beat omits it; in this example `b2` inherits `open_palms` from the resolved-state snapshot because no new gesture was written — see §5.5/§7.4.2 for the precise asymmetry) and `posture=upright` (sticky from `b1`), and its `camera` is absent in the doc — the compiler resolves it to `b1`'s `medium_close dolly_in` per §2.6/§5.5 sticky rules at *compile* time, not parse time. (`*…*` → `moderate`, `**…**` → `strong`.)

### 3.12 Parser API & diagnostics

```ts
// packages/protocol/src/ncast/parse.ts
export interface NcastDiagnostic {
  line: number; col: number;
  severity: 'error' | 'warning';
  code: string;        // e.g. 'unknown-emotion', 'bad-shot', 'unclosed-boneyard'
  message: string;
}
export interface NcastParseResult {
  doc?: NewsReportDoc;          // present iff no 'error' diagnostics
  diagnostics: NcastDiagnostic[];
  source: string;               // original text (for round-trip / editor)
}

export function parseNcast(text: string): NcastParseResult;
export function serializeNcast(doc: NewsReportDoc): string;   // canonical → .ncast (best-effort, lossy on notes)
```

`parseNcast` runs zod validation on the assembled doc; any zod issue becomes a line-mapped `NcastDiagnostic`. Out-of-vocabulary enum tokens (`emotion`, `gesture`, `posture`, `shot`, `move`, `target`, `easing`, `storyForm`, `transition.type`, `set.mode`, `graphic.kind`, `audio.kind`, `look.preset`) are hard errors with the offending span and the allowed set in the message. The avatar-live import hook (the existing `timelineFileEl` discriminator in `projectStore`) is extended to detect a `.ncast` extension or a leading `---`/`#`/`::` and route through `parseNcast` → `NewsReportDoc` → the §7 compiler.

### 3.13 Embedded-TS fluent builder

The builder is a typed, chainable API in `packages/protocol` that **emits the identical `NewsReportDoc`**. It exists for programmatic generation (LLM tool-calling, tests, codegen) where authoring TS is preferable to text. Every method name corresponds to a canonical §2 field; the enums are the literal TS union types from `dsl.ts`/§2, so misuse is a compile error.

```ts
// packages/protocol/src/builder.ts
import type {
  NewsReportDoc, Emotion, Gesture, Posture, StoryForm,
  Shot, Move, Target, Easing,
  PostProcessingSpec, SetMode, Transition, Gaze,
} from './index.js';

export function report(meta: {
  title: string; language?: string; fps?: number; aspect?: string;
}): ReportBuilder;

export interface ReportBuilder {
  anchor(a: { id: string; name: string; avatarUrl: string; voiceId: string }): this;
  look(spec: PostProcessingSpec['preset'] | Partial<PostProcessingSpec>): this;     // SP-2
  brandKit(bk: BrandKitInput): this;                                    // Later
  defaults(d: DefaultsInput): this;                                     // seeds carry-forward

  block(label: 'A'|'B'|'C'|'D'): this;                                  // sets current block for following sections
  section(storyForm: StoryForm, slug: string): SectionBuilder;          // opens & returns a section

  build(): NewsReportDoc;                                               // zod-validated; throws on invalid
  toNcast(): string;                                                    // == serializeNcast(this.build())
}

export interface SectionBuilder {
  id(id: string): this;
  anchorId(id: string): this;
  set(s: { mode: SetMode; backScreen?: BackScreenInput }): this;
  cameraDefault(c: CameraCueInput): this;
  lookOverride(spec: PostProcessingSpec['preset'] | Partial<PostProcessingSpec>): this;
  adBreakAfter(on?: boolean): this;
  softTime(sec: number): this;
  hardTime(sec: number, hardOut?: boolean): this;
  timeFit(t: TimeFitInput): this;

  beat(text: string): BeatBuilder;          // opens & returns a beat
  graphic(g: GraphicInput): this;           // appends to Section.graphics
  audio(a: AudioCueInput): this;            // appends to Section.audio

  end(): ReportBuilder;                     // back to report scope
}

export interface BeatBuilder {
  id(id: string): this;
  emotion(e: Emotion): this;
  gesture(g: Gesture): this;
  posture(p: Posture): this;
  emphasis(text: string, level?: 'reduced' | 'moderate' | 'strong'): this;  // canonical §2 levels
  prosody(p: { rate?: number; pitch?: number; volume?: number }): this;      // V2
  sayAs(as: 'date'|'time'|'number'|'ordinal'|'telephone'|'currency'|'spell'|'address', text: string): this; // V2
  phoneme(ipa: string, text: string): this;                                  // V2
  pause(ms: number): this;                                                    // Beat.pause_ms_after
  gaze(g: Gaze): this;                                                       // 'camera'|'coAnchor'|'monitor' (V2)
  camera(c: CameraCueInput): this;                                          // Beat.camera
  transition(type: Transition, dur?: number): this;                         // V2
  lookOverride(spec: PostProcessingSpec['preset'] | Partial<PostProcessingSpec>): this; // V2
  blocking(b: BlockingInput): this;                                         // Later
  note(text: string): this;                                                // [[director note]] — non-rendering

  end(): SectionBuilder;                    // back to section scope
}

// Loose input shapes the builder normalizes to canonical (defaults filled to match the .ncast parser):
export interface CameraCueInput {
  shot?: Shot; move?: Move; target?: Target;
  easing?: Easing; intensity?: number;                  // defaults: move=static, target=face, easing=ease_in_out, intensity=0.5
}
export interface GraphicInput {
  kind: Graphic['kind']; at?: number; out?: number; anim?: string;
  title?: string; subtitle?: string; src?: string;      // + kind-specific (side,corner,speed,chartType,data,center,zoom,markers)
  [k: string]: unknown;
}
export interface AudioCueInput {
  kind: 'bed'|'sfx'|'natpop'|'sot'; src: string; start?: number; duration?: number;
  volume?: number; fadeIn?: number; fadeOut?: number; duck?: { target: 'voice'; amount: number };
}
```

**Equivalence guarantee.** The builder and the parser are two front-ends over one assembler:

```ts
parseNcast(text).doc  ≡  /* the builder calls implied by text */ .build()
report(...).…​.toNcast()  →  parseNcast(...)  round-trips (modulo notes/boneyard, formatting)
```

Both produce a value that passes `NewsReportDoc` zod validation in `packages/protocol`, and both feed the **same** downstream §7 compiler to `ProjectDoc`/`Cue[]` (avatar-live) and `EngineRenderSpec`/`PerformanceManifest` (engine-three).

**Fluent example** (emits the §3.11 doc):

```ts
const doc = report({ title: 'Evening Edition', language: 'en-US', fps: 30 })
  .anchor({ id: 'maya', name: 'Maya Chen', avatarUrl: '/a/maya.glb', voiceId: 'vx_maya' })
  .look('broadcast')
  .defaults({ emotion: 'confident', posture: 'upright',
              camera: { shot: 'medium' }, set: { mode: 'virtual' } })
  .block('A')
  .section('READER', 'Transit plan unveiled')
    .anchorId('maya').adBreakAfter().softTime(90)
    .audio({ kind: 'bed', src: '/music/bed.mp3', volume: 0.15, fadeOut: 2 })
    .graphic({ kind: 'lowerThird', title: 'Maya Chen', subtitle: 'Reporter', at: 0.5, out: 4 })
    .beat('Good evening. The city unveiled a sweeping transit plan today.')
      .emotion('warm').gesture('open_palms')
      .emphasis('unveiled', 'moderate')
      .camera({ shot: 'medium_close', move: 'dolly_in', target: 'face', easing: 'ease_in_out', intensity: 0.6 })
    .end()
    .beat('Officials say it adds forty miles of rail.')
      .emotion('serious').emphasis('forty miles', 'strong').pause(400)
      .note('verify w/ desk')
    .end()
  .end()
  .build();
```

### 3.14 Tier summary for this section

| Capability | MVP | V2 | Later |
|---|---|---|---|
| Frontmatter `title/language/fps/anchors/look(preset)/defaults` | ✅ | | |
| Frontmatter `captions/brandKit` | | captions | brandKit full |
| `#`/`##` headers, story-form, block, slug, `set`, `cam=`, `anchor=` | ✅ | | |
| `ad-break-after` flag (record) / scheduling (soft/hard/kill/float/pad) | flag | | scheduling |
| Dialogue, parenthetical `emotion/gesture/posture`, `{pause}` | ✅ | | |
| `prosody`, `sayAs`, `phoneme`, `**strong**` emphasis, `gaze` | `*…*`→moderate | ✅ | |
| Camera `>>`/`CAM` lines (full vocab) | ✅ | | |
| Transitions `> TYPE DUR >` (non-cut) | cut default | ✅ | |
| Graphics lower-third / fullscreen / still | fullscreen, still | lowerThird | |
| Graphics OTS / ticker / bug / bumper | | ticker, bug, bumper | OTS |
| Audio `~ bed:` | ✅ | | |
| Audio `~ sfx:` / `~ natpop:` / `~ sot:` / `duck=` | | sfx, duck | sot/natpop clip handling |
| Notes `[[…]]`, boneyard `/* */`, `%% directives` | ✅ | | |
| TS fluent builder (full surface, MVP-tagged methods active) | ✅ | V2 methods | Later methods |

---

## 4. Complete vocabulary (enums, existing vs new)

This section is the **single source of truth for the status/tier of every enumerated value** in the Newscast DSL. The canonical TS surface lives in [§2.5](#25-shared-vocab-enums); here each value is tagged **Status** (`EXISTING` in code, or `NEW` to build) and **Tier** (`MVP`/`V2`/`Later`). No section may introduce an enum value not listed here.

Citations: `dsl.ts` = `packages/protocol/src/dsl.ts`; `catalog.ts` = `apps/avatar-live/src/timeline/catalog.ts`; `ProjectDoc`/`Cue` = the avatar-live shapes.

Where a vocabulary is **protocol-canonical** (the DSL surface) but the runtime exposes a different concrete vocabulary (avatar-live presets / engine-three nodes), the canonical value is authoritative and §4.10 specifies the lowering.

### 4.1 Emotions

```
Emotion = neutral | warm | happy | excited | serious
        | concerned | sad | confident | thoughtful | surprised
```

| Value | Status | Tier | Notes |
|---|---|---|---|
| `neutral` | EXISTING — `dsl.ts` | MVP | default |
| `warm` | EXISTING | MVP | |
| `happy` | EXISTING | MVP | |
| `excited` | EXISTING | MVP | |
| `serious` | EXISTING | MVP | hard-news default |
| `concerned` | EXISTING | MVP | |
| `sad` | EXISTING | MVP | |
| `confident` | EXISTING | MVP | |
| `thoughtful` | EXISTING | MVP | |
| `surprised` | EXISTING | MVP | |

**New runtime capability (not new vocab):** `avatarController.setEmotion(name, intensity)` exists, but **emotion cross-fade** between beats is a runtime GAP to add (V2). The vocab is unchanged.

### 4.2 Gestures

```
Gesture = none | wave | point | open_palms | count
        | thumbs_up | nod | shrug | hand_to_chest | explain
```

| Value | Status | Tier | Notes |
|---|---|---|---|
| `none` | EXISTING — `dsl.ts` | MVP | default |
| `wave` | EXISTING | MVP | → `motion.wave` |
| `point` | EXISTING | MVP | → `motion.point` |
| `open_palms` | EXISTING | MVP | |
| `count` | EXISTING | V2 | needs `count` clip; no avatar-live mapping yet |
| `thumbs_up` | EXISTING | V2 | no avatar-live mapping yet |
| `nod` | EXISTING | MVP | → `motion.nod` |
| `shrug` | EXISTING | V2 | |
| `hand_to_chest` | EXISTING | V2 | |
| `explain` | EXISTING | MVP | → `motion.explain` |

**No new gesture values.** The avatar-live `motion.*` catalog (`turnScreen`, `faceFront`, `point`, `wave`, `nod`, `explain`) is the *runtime* layer, not the DSL surface; gestures lower onto it (§4.10.4). `turnScreen`/`faceFront` are produced by the compiler from `Beat.gaze` + `blocking`, not authored as gestures.

### 4.3 Postures

```
Posture = neutral | leaning_in | upright | relaxed | turned_slightly
```

**Protocol-only today — not yet wired in avatar-live.** Wiring is a V2 runtime task; the vocab ships MVP in the doc schema so authors can write it now.

| Value | Status | Tier | Notes |
|---|---|---|---|
| `neutral` | EXISTING — `dsl.ts` | MVP (vocab) / V2 (runtime) | default |
| `leaning_in` | EXISTING | V2 | "into the story" |
| `upright` | EXISTING | V2 | formal anchor |
| `relaxed` | EXISTING | V2 | kicker / chat |
| `turned_slightly` | EXISTING | V2 | toward co-anchor / monitor; compiles to a small `setTurn` |

**Runtime GAP (V2):** add **static-pose-without-clip** so a posture holds between gestures.

### 4.4 Body clips

Lowest runtime layer; **not** an author-facing enum — the compiler selects them from gesture/motion.

```
BodyClip = idle_calm | talk1 | talk2 | talk3 | talk4 | talk5
```

| Value | Status | Tier | Selected by |
|---|---|---|---|
| `idle_calm` | EXISTING | MVP | rest / no gesture |
| `talk1` | EXISTING | MVP | `explain`, generic speech |
| `talk2` | EXISTING | V2 | speech variety |
| `talk3` | EXISTING | MVP | `point` |
| `talk4` | EXISTING | V2 | speech variety |
| `talk5` | EXISTING | MVP | `wave` |

Driven via `avatarController.playClip(name, fade)` and `setIdleMotion`.

### 4.5 Face channels

The 8 abstract visemes/expression channels (`FaceChannels`), driven by `setMouth`/`setNamedFace`/`setLipsync`. Author-facing only via `Beat.phoneme` (V2) and lip-sync; otherwise computed from audio.

```
FaceChannel = jawOpen | mouthWide | mouthRound | mouthClose
            | smile | frown | browRaise | blink
```

| Value | Status | Tier | Source |
|---|---|---|---|
| `jawOpen` | EXISTING | MVP | lip-sync amplitude |
| `mouthWide` | EXISTING | MVP | viseme |
| `mouthRound` | EXISTING | MVP | viseme |
| `mouthClose` | EXISTING | MVP | viseme |
| `smile` | EXISTING | MVP | emotion mix |
| `frown` | EXISTING | MVP | emotion mix |
| `browRaise` | EXISTING | MVP | emotion / emphasis |
| `blink` | EXISTING | MVP | autonomic (seeded per frame index for determinism — §8.1.3) |

**Runtime GAPs (V2):** **blink force/suppress** and explicit **head tilt/nod** control. No new face-channel enum values; these are control APIs.

### 4.6 Story-forms

`Section.storyForm`. **Entirely NEW vocab.** Drives compiler defaults for camera, set, graphics, audio per section (§5.3). The canonical de-duplicated set is **10** values:

```
StoryForm = READER | VO | VOSOT | PKG | LIVE | LOOK_LIVE
          | DONUT | MOS | STANDUP | KICKER
```

| Value | Status | Tier | Meaning / compiler default |
|---|---|---|---|
| `READER` | NEW | MVP | anchor on-camera, no media. Default `cam.anchor`, set `virtual`. |
| `VO` | NEW | MVP | voice-over full-screen B-roll/graphic. Default fullscreen graphic + duck bed. |
| `VOSOT` | NEW | V2 | VO into a sound-on-tape (interview clip) `AudioCue{kind:'sot'}`. |
| `PKG` | NEW | V2 | pre-produced package; anchor toss in/out. |
| `LIVE` | NEW | Later | live remote; two-box / OTS framing. |
| `LOOK_LIVE` | NEW | Later | recorded-as-live. |
| `DONUT` | NEW | Later | live wrap around a PKG (intro live → pkg → tag live). |
| `MOS` | NEW | Later | man-on-street montage of SOTs. |
| `STANDUP` | NEW | V2 | reporter standup framing. |
| `KICKER` | NEW | MVP | light closing story; `relaxed` posture, `warm` look default. |

Unknown/legacy values reject at validation; the parser must not silently coerce.

### 4.7 Camera vocabulary

The DSL exposes the **protocol-canonical semantic camera vocab** (`CameraCue`), *not* avatar-live preset ids. All four enums + `intensity` are EXISTING in `dsl.ts`. The lowering is §4.10.

#### 4.7.1 Shots
```
Shot = wide | full | medium | medium_close | close_up | extreme_close_up
```
| Value | Status | Tier |
|---|---|---|
| `wide` | EXISTING | MVP |
| `full` | EXISTING | MVP |
| `medium` | EXISTING (default) | MVP |
| `medium_close` | EXISTING | MVP |
| `close_up` | EXISTING | MVP |
| `extreme_close_up` | EXISTING | V2 |

#### 4.7.2 Moves
```
Move = static | dolly_in | dolly_out | truck_left | truck_right
     | pan_left | pan_right | pedestal_up | pedestal_down
     | orbit_left | orbit_right
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `static` | EXISTING (default) | MVP | hold |
| `dolly_in` | EXISTING | MVP | push |
| `dolly_out` | EXISTING | MVP | pull |
| `truck_left` | EXISTING | V2 | lateral |
| `truck_right` | EXISTING | V2 | lateral |
| `pan_left` | EXISTING | V2 | rotate target |
| `pan_right` | EXISTING | V2 | rotate target |
| `pedestal_up` | EXISTING | V2 | vertical |
| `pedestal_down` | EXISTING | V2 | vertical |
| `orbit_left` | EXISTING | V2 | → `cam.orbit` (left) |
| `orbit_right` | EXISTING | V2 | → `cam.orbit` (right) |

#### 4.7.3 Targets
```
Target = eyes | face | chest | torso | full_body
```
| Value | Status | Tier |
|---|---|---|
| `eyes` | EXISTING | V2 |
| `face` | EXISTING (default) | MVP |
| `chest` | EXISTING | MVP |
| `torso` | EXISTING | V2 |
| `full_body` | EXISTING | MVP |

#### 4.7.4 Easings
```
Easing = linear | ease_in | ease_out | ease_in_out
```
| Value | Status | Tier |
|---|---|---|
| `linear` | EXISTING | MVP |
| `ease_in` | EXISTING | MVP |
| `ease_out` | EXISTING | MVP |
| `ease_in_out` | EXISTING (default) | MVP |

#### 4.7.5 Intensity
`intensity: number 0..1`, default `0.5` — EXISTING. Scales the **travel** of `move` across the beat. MVP.

#### 4.7.6 Angle / focus (v2 extensions)
`CameraCue.angle ∈ eye|low|high|dutch` (NEW, V2) and `CameraCue.focus {distance?,bokeh?}` (NEW, V2). `angle` offsets pose pitch/roll (`dutch`→roll); `focus` feeds `look.effects.dof` for that beat.

### 4.8 Transitions

`Beat.transition.type` and section-boundary transitions. **NEW vocab.** `cut` is MVP; rest V2.

```
Transition = cut | dissolve | fade | wipe | defocus
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `cut` | NEW | MVP | instant; zero-duration default |
| `dissolve` | NEW | V2 | cross-fade between framings/sources |
| `fade` | NEW | V2 | to/from black |
| `wipe` | NEW | V2 | directional |
| `defocus` | NEW | V2 | rack-focus transition, leans on `look.effects.dof` |

`transition = { type: Transition, dur: number(seconds) }`. `dur` ignored for `cut`.

### 4.9 Set modes

`Section.set.mode`. **NEW vocab.** Pairs with optional `set.backScreen` (§2.7.1).

```
SetMode = real | chroma | virtual | LED | AR
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `virtual` | NEW | MVP | 3D studio + video wall (`studioOn`) — the default |
| `chroma` | NEW | V2 | keyed background; `backScreen` becomes a full key fill |
| `LED` | NEW | V2 | LED-volume look (back wall is the source) |
| `real` | NEW | MVP (field/STANDUP) | real-set plate |
| `AR` | NEW | Later | augmented graphics over the set |

`backScreen.kind` values (§2.7.1, canonical): `none | color | image | video | stream | chart`. There is **no** `cast`/`url`/`source` kind; a live source is `stream` (Later).

### 4.10 CAMERA-VOCAB RECONCILIATION (canonical → avatar-live → engine-three)

The load-bearing mapping. **The DSL only ever exposes the semantic protocol vocab** (`CameraCue` = `shot/move/target/easing/intensity`). It never exposes avatar-live preset ids (`cam.*`) or raw `Pose`s as authored values — those are *compile targets*. (See [§7.2.4](#724-cameracue--avatar-live-camera-preset-cam) for the full compiler table.)

#### 4.10.1 Compile target A — avatar-live

A `CameraCue` lowers to a `Cue{track:'camera'}` whose **resolved framing** is a head-relative `Pose = [px,py,pz, tx,ty,tz, fov]`. Two stages:

**Stage 1 — shot+target → base preset + pose.** The compiler computes a `CameraPose` via head-relative math (`poseFor(type, hc, hh)` in `catalog.ts`), keyed on `(shot, target)`, then emits `poseToTuple(pose)`:

```
(shot, target)            → base avatar-live preset (poseFor seed)   → Pose tuple
wide        , full_body   → cam.wide        (pull hh*8.5, target dropped)
full        , torso       → between cam.wide / cam.anchor
medium      , chest|face  → cam.anchor      (hh*3.6, eye-level)        ← default
medium_close, face        → between cam.anchor / cam.close
close_up    , face|eyes   → cam.close       (hh*2.2, fov 30)
extreme_close_up, eyes    → tighter than cam.close (fov ↓, dist ↓)
```
`target` shifts the look-at point on the body axis (`eyes`/`face` = head height `hc.y`; `chest`/`torso`/`full_body` lower `target.y` and pull back).

**Stage 2 — move+intensity+easing → animated pose / path.** The base pose is the *end* framing; `move` synthesizes the *start* framing (or a path):

```
move          → avatar-live cue realization
static        → single Pose held (Cue.pose), no interpolation
dolly_in      → start pose pulled back by intensity·Δz, ease to base       (Cue.pose, eased)
dolly_out     → start pose pushed in,  ease out to base
truck_left/right   → start pose offset ±x by intensity·k                    (Cue.pose, eased)
pan_left/right     → start target offset ±x (rotate look-at)                (Cue.pose, eased)
pedestal_up/down   → start pose/target offset ±y                            (Cue.pose, eased)
orbit_left/right   → cam.orbit, signed; emitted as Cue.path arc of angle = intensity·θmax
```
- `intensity` scales Δ; `easing` maps directly to the cue's interpolation curve.
- `static`/offset-moves emit `Cue.pose`; `orbit_*` emits `Cue.path`. Reuses the existing `Cue{track:'camera', pose?, path?}` shape — no new Cue fields.
- Section `cameraDefault` and sticky carry-forward: a section with no per-beat `camera` inherits the section default, which inherits the previous section's last resolved framing (Ren'Py-style, §5.5).

#### 4.10.2 Compile target B — engine-three

The same `CameraCue` lowers to an engine-three **camera node** in `SceneDocument`/`EngineRenderSpec`, driven by `compileManifest`'s sticky carry-forward:
```
shot+target  → camera node { position, lookAt, fov }   (semantic framing, world-space)
move+intensity+easing → keyframed transform over the beat's [t0,t1]
                        static→hold; dolly→±position.z; truck→±x; pan→rotate lookAt;
                        pedestal→±y; orbit→arc around target
```
Because engine-three consumes `EngineRenderSpec`/`PerformanceManifest` directly, **the canonical `CameraCue` is passed through nearly verbatim**. This is the authoritative path; avatar-live's pose-tuple lowering must produce a **visually equivalent** framing so browser-preview and GPU-master agree.

**Invariant:** `shot/target` fully determine the *end* framing; `move/intensity/easing` determine *how it gets there*. Both backends MUST agree on the end framing for a given `(shot,target,head)`.

#### 4.10.3 Lighting presets

avatar-live lighting presets (runtime layer, mirror `ProjectDoc.lights.preset`): `studio | soft | dramatic | warm | cool`. Driven by the `look`→lights bridge (§7.2.6) or explicit `defaults.lights`/`Section.lights`.

#### 4.10.4 Motion presets

avatar-live motion catalog (runtime layer, not author-facing): `motion.turnScreen | motion.faceFront | motion.point | motion.wave | motion.nod | motion.explain`. Gestures + gaze + blocking lower onto these (§7.2.5).

### 4.11 Graphic kinds

`Graphic.kind` (canonical §2.9). **NEW vocab.**

```
GraphicKind = lowerThird | fullscreen | OTS | ticker | bug | still | chart | map | bumper
```
| Value | Status | Tier | Kind-specific fields (canonical §2.9) |
|---|---|---|---|
| `lowerThird` | NEW | V2 | `{ title, subtitle?, style? }` |
| `fullscreen` | NEW | MVP | `{ src, caption?, fit }` |
| `OTS` | NEW | Later | `{ src, label?, side }` |
| `ticker` | NEW | V2 | `{ items[], speed, position }` |
| `bug` | NEW | V2 | `{ src, corner, opacity }` |
| `still` | NEW | MVP | `{ src, x, y, scale }` |
| `chart` | NEW | Later | `{ chartType, data[], title? }` |
| `map` | NEW | Later | `{ center, zoom, markers[] }` |
| `bumper` | NEW | V2 | `{ src, audioSrc? }` |

`at`/`out` are section-relative seconds; `anim ∈ none|fade|slide|slideUp|wipe|pop` (def `fade`); `layer 0–100` (def `10`). The `headline` carrier (avatar-live `ProjectDoc.headline`) is the MVP realization of a single `lowerThird`/`fullscreen` title.

### 4.12 Look / post-processing vocabulary

`look = PostProcessingSpec` (canonical §2.11). **Entirely NEW** (chore SP-2).

#### 4.12.1 Look presets
```
LookPreset = none | broadcast | cinematic | warm | cool | neutral-agx | noir
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `none` | NEW | MVP | passthrough (RenderPass + SMAA only) |
| `broadcast` | NEW | MVP | **default** — bloom(0.3,thr0.85)→ACES exp1.05→neutral LUT→gentle grade→subtle vignette→grain(0.04)→mild sharpen→SMAA |
| `cinematic` | NEW | V2 | stronger bloom + DoF + heavier grade |
| `warm` | NEW | MVP | kicker/human-interest (temp+) |
| `cool` | NEW | MVP | hard-news (temp−) |
| `neutral-agx` | NEW | Later | AgX tonemap — **gated**: needs three.js r160 (pinned 0.152.2 ships ACES only; falls back to ACES) |
| `noir` | NEW | V2 | desaturated high-contrast |

#### 4.12.2 Anti-aliasing
```
effects.aa = smaa | msaa | none
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `smaa` | NEW | MVP | default; runs **last** in the chain |
| `msaa` | NEW | V2 | |
| `none` | NEW | MVP | |

#### 4.12.3 Tone-mapping operators
```
effects.toneMapping.operator = none | linear | reinhard | cineon | aces | agx
effects.toneMapping.exposure : number (default 1.05 for broadcast)
```
| Operator | Status | Tier | Notes |
|---|---|---|---|
| `aces` | NEW | MVP | default (ACES Filmic). **Lowercase enum** (`aces`, not `ACES`). |
| `none`/`linear`/`reinhard`/`cineon` | NEW | V2 | |
| `agx` | NEW | Later | gated on r160 bump |

> Renderer is `NoToneMapping`; the `postprocessing` `ToneMappingEffect` performs tonemap. HDR effects run **before** tonemap, LDR effects **after**.

#### 4.12.4 Effect parameters (full)
Pipeline order (§8.2.3): `scene→[HalfFloat]→(AO/DoF/MotionBlur/Bloom)→ToneMapping→LUT/grade→ChromaticAberration→Vignette→Grain→Sharpen→SMAA`.

| Effect (HDR, pre-tonemap) | Params | Status | Tier |
|---|---|---|---|
| `ao` | `{ intensity }` | NEW | V2 |
| `dof` | `{ focusDistance, bokehScale }` | NEW | V2 |
| `motionBlur` | `{ intensity }` | NEW | Later |
| `bloom` | `{ intensity, threshold, radius }` | NEW | MVP |

| Effect (LDR, post-tonemap) | Params | Status | Tier |
|---|---|---|---|
| `lut` | `{ url, intensity }` | NEW | MVP (neutral default) |
| `grade` | `{ contrast, saturation, temperature, tint, exposure }` | NEW | MVP |
| `chromaticAberration` | `{ offset }` | NEW | V2 |
| `vignette` | `{ darkness, offset }` | NEW | MVP |
| `grain` | `{ intensity }` | NEW | MVP |
| `sharpen` | `{ amount }` | NEW | MVP |

> **Engine-three guard (SP-2):** validate a float-RT `EffectComposer` round-trip in headless `gl`/Xvfb **before** wiring any of the above into the offline path (§8.2.6).

### 4.13 Audio kinds + ducking

`AudioCue.kind` (canonical §2.10). **NEW vocab.**

```
AudioKind = bed | sfx | natpop | sot
duck      = { target:'voice', amount }
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `bed` | NEW (carrier EXISTING) | MVP | music bed |
| `sfx` | NEW | MVP | one-shot effect |
| `natpop` | NEW | V2 | natural-sound pop |
| `sot` | NEW | V2 | sound-on-tape (package) |
| `duck.target` = `voice` | NEW | V2 | only legal target |
| `duck.amount` : 0..1 | NEW | V2 | gain reduction during narration |

`volume`/`fadeIn`/`fadeOut`/`start`/`duration` map 1:1 onto the existing `Cue` audio fields. The SP-1 offline renderer mixes all `AudioCue`s + narration into a single `AudioBuffer`.

### 4.14 Captions

`meta.captions = CaptionsSpec` (canonical §2.12). **NEW vocab.**

```
CaptionsSpec = { enabled, mode, standard, cleanFeed }
mode     = burnedIn | sidecar | both
standard = 608 | 708 | webvtt | srt
```
| Value | Status | Tier | Notes |
|---|---|---|---|
| `enabled` | NEW | MVP | on/off |
| `mode = sidecar` | NEW | MVP | default; WebVTT sidecar |
| `mode = burnedIn` | NEW | V2 | burn into MP4 |
| `mode = both` | NEW | Later | dirty + clean |
| `standard = webvtt/srt` | NEW | MVP/V2 | text standards |
| `standard = 608/708` | NEW | Later | broadcast caption encoding |
| `cleanFeed` | NEW | Later | also produce a textless clean master |

> "Dirty" (graphics+captions burned) vs "clean" (textless) feeds = `mode:'both'` + `cleanFeed:true` (Later).

### 4.15 Capture formats (render output)

The 6 MP4 output formats (chore SP-1). `meta.aspect` selects shape; a render-request resolution tier selects pixels.

```
CaptureFormat = 720p | 1080p | 1440p | 4K UHD 3840x2160 | vertical 1080x1920 | square 1080
```
| Value | Pixels | Status | Tier |
|---|---|---|---|
| `720p` | 1280×720 | NEW | MVP |
| `1080p` | 1920×1080 | NEW | MVP (default) |
| `1440p` | 2560×1440 | NEW | V2 |
| `4K UHD 3840x2160` | 3840×2160 | NEW | V2 |
| `vertical 1080x1920` | 1080×1920 | NEW | V2 |
| `square 1080` | 1080×1080 | NEW | V2 |

```
VideoCodec = avc1 | hvc1        (avc1 = H.264 default MVP; hvc1 = H.265 V2, gated by isConfigSupported)
Container  = mp4 | webm         (mp4 default; webm fallback)
```

**Consistency contract:** any value not in §4.1–§4.15 (and §2.5) is invalid. New enums to add to `packages/protocol` this milestone: `StoryForm`, `Transition`, `SetMode`, `Gaze`, `Graphic.kind` union, `PostProcessingSpec` (+ `aa`, `toneMapping.operator`, look presets), `AudioCue.kind`/`duck`, `CaptionsSpec`, then `npm run protocol:schema`. The Emotion/Gesture/Posture/Camera enums are reused unchanged from `dsl.ts`.

---

## 5. Rundown & timing model

The rundown is the spine of a `NewsReportDoc`: an ordered list of `Section`s that the compiler walks top-to-bottom to emit `ProjectDoc`+`Cue[]` (avatar-live) or `EngineRenderSpec`/`PerformanceManifest` (engine-three). This section defines section ordering, ad-break blocking, story-form staging, timing/back-timing, sticky carry-forward, and set modes. Everything lowers deterministically. Type shapes are authoritative in [§2](#2-canonical-schema-newsreportdoc--full-type-reference); this section defines the **timing types** (`AdBreak`, `TimeFit`, `Channel`, `Lighting`, `TimingReport`) and the **semantics**.

### 5.1 Rundown shape & ordering

The rundown is `rundown: Section[]` on `NewsReportDoc` (§2.1). **Array order is authoritative order** — sections play in the order they appear; there is no separate `order` field. The compiler assigns each section a 1-based `rundownIndex` from its array position for display/back-timing only. The `Section` shape is defined in [§2.7](#27-section).

Empty `beats: []` is legal only for `storyForm: 'LIVE'` placeholders and ad-bumper sections (a `KICKER`/bare `set` with a `bumper` graphic). A section with no beats and no bumper graphic is a compile **error** (`E_EMPTY_SECTION`). (Note: the §2.7 schema marks `beats` `.min(1)`; the empty-section exception is enforced by a refinement that allows `[]` only for `LIVE` / bumper-only sections.)

### 5.2 Blocks A/B/C/D and ad-breaks

A block is a contiguous run of sections; the boundary between blocks is exactly an `adBreakAfter` marker. `Section.block ∈ A|B|C|D` (§2.7).

- **Block A** — top of show: cold open / headlines / lead story.
- **Block B** — second segment: developing / regional stories.
- **Block C** — third segment: features, lighter content.
- **Block D** — kicker / weather / sign-off.

```ts
export const AdBreak = z.object({
  id: z.string().min(1),
  kind: z.enum(['commercial','promo','station_id','bumper_only']),
  duration: z.number().min(0).default(120),   // seconds reserved on the running-time clock
  bumperIn: z.string().optional(),            // Graphic.id to play out of the segment (pre-break)
  bumperOut: z.string().optional(),           // Graphic.id to play returning from break (post-break)
  hard: z.boolean().default(false),           // true = break at a fixed hardTime (network/affiliate join)
});
```

**Block assignment rules (deterministic):**
1. If `Section.block` is explicitly set, it wins.
2. Otherwise the compiler assigns blocks by **ad-break partitioning**: sections before the first `adBreakAfter` → `A`, between first and second → `B`, then `C`, then `D`; blocks beyond `D` clamp to `D`.
3. `adBreakAfter` on the final section is ignored with warning `W_TRAILING_ADBREAK`.

Ad-break `duration` counts against total running time for back-timing (§5.4) but produces **no rendered frames** by default — the encoder skips break time and emits a hard `cut` between `bumperIn` out-point and the next section's first frame. A future "full broadcast master" (Later) may render slate; flag `meta.renderAdBreaks?: boolean` (default `false`). In MVP, `Section.adBreakAfter` is a boolean marker (the full `AdBreak` object is Later).

### 5.3 Story-forms

`storyForm` (§4.6) selects a **staging template**: a bundle of default camera, graphics, audio, and gaze behavior applied to the section before its beats' own cues override them. Defaults are *seeds*; explicit `Beat.camera`, `Section.graphics`, etc. override (§5.5 precedence). All camera values use the §4 protocol vocab; all gestures/emotions/postures use the §4 enums.

#### 5.3.1 Per-form default staging

"Camera" entries are `CameraCue` seeds; "graphics" are auto-inserted `Graphic` stubs (authors suppress with `Section.suppressAutoGraphics: true`).

| storyForm | default camera (`cameraDefault` if unset) | default gaze | default set.mode | auto graphics | audio behavior |
|---|---|---|---|---|---|
| `READER` | `{shot:'medium_close', move:'static', target:'face', easing:'linear'}` | `camera` | `virtual` | `lowerThird` at first beat | bed continues, ducked under VO |
| `VO` | `{shot:'medium', move:'static', target:'chest'}` | `camera` | `virtual` (backScreen = B-roll) | `lowerThird` + `bug` | natpop from B-roll under voice (`duck` voice) |
| `VOSOT` | VO framing; on SOT beat → `{shot:'full', move:'static', target:'full_body'}` widen | `camera`, off-cam during SOT | `virtual` | `lowerThird`; SOT clip = `fullscreen` | VO: bed ducked; SOT: SOT audio full, bed muted |
| `PKG` | intro `{shot:'medium_close', target:'face'}`; PKG body = `fullscreen` | `camera` | `virtual` | `lowerThird` (intro), `fullscreen` (pkg) | bed ducked under intro; PKG carries its own track |
| `LIVE` | `{shot:'medium', move:'static', target:'chest'}` two-box | `camera` (toss) → `monitor` | `virtual` (two-box) | `lowerThird` (LIVE bug), `bug` | live-source audio full; bed low |
| `LOOK_LIVE` | as `LIVE` but single-box | `camera` | `virtual` | `lowerThird` | as VO (no true live audio) |
| `DONUT` | LIVE intro → PKG `fullscreen` → LIVE tag | `camera`/`monitor`/`camera` | `virtual` | `lowerThird` (intro+tag), `fullscreen` (pkg) | live audio on intro/tag, PKG track on body |
| `MOS` | `{shot:'medium_close', target:'face'}` per soundbite | off-cam (subjects) | `virtual` (fullscreen clips) | `lowerThird` per speaker | each soundbite audio full; bed under cuts |
| `STANDUP` | `{shot:'medium', move:'static', target:'chest'}` field | `camera` | `real` or `virtual` (field) | `lowerThird` (reporter+location) | natpop bed from field; voice full |
| `KICKER` | `{shot:'medium_close', target:'face'}` warmer | `camera`/`coAnchor` | `virtual` | `bug` only | music bed up (sign-off), no duck |

Notes:
- `VOSOT`/`DONUT` are **multi-phase**: the compiler segments beats into phases by the presence of a `transition` or a beat carrying a `fullscreen`/SOT `Graphic`/`AudioCue{kind:'sot'}`. Phase boundaries get an automatic `transition.type:'cut'` unless the beat specifies otherwise.
- `PKG`/`DONUT`/`VOSOT` body clips are `Graphic{kind:'fullscreen'}` with `src`; their intrinsic duration drives back-timing for that phase. If unknown pre-render, fall back to WPM/`pause_ms_after` estimation and mark `timingSource:'estimated'`.
- `MOS` requires ≥2 beats; single-beat MOS warns `W_MOS_SINGLE`.
- `STANDUP` is the only form whose default `set.mode` may be `real`; all others default `virtual`.
- An explicit `Section.cameraDefault` overrides the form's seed; an explicit `Beat.camera` overrides for that beat onward (sticky, §5.5).

### 5.4 Timing & back-timing

Every beat, phase, section, and break has a **duration** from one of three sources, priority order:

```
timingSource precedence (highest wins):
  1. 'measured'   — real TTS clip length (post-TTS) or known media clip duration
  2. 'explicit'   — author-set duration on a Beat/Graphic/AudioCue
  3. 'estimated'  — WPM back-of-envelope from text (pre-TTS)
```

#### 5.4.1 WPM estimation (pre-TTS)

```
beatReadSeconds(beat) =
    (wordCount(beat.text) / effectiveWpm(beat)) * 60
  + beat.pause_ms_after / 1000

effectiveWpm(beat) =
    beat.prosody?.rate ? defaultWpm * beat.prosody.rate
                       : (section.wpm ?? meta.wpm ?? DEFAULT_WPM)

DEFAULT_WPM = 130              // broadcast anchor read pace
```

- `DEFAULT_WPM = 130` (broadcast pace). Override hierarchy: `Beat.prosody.rate` → `Section.wpm` → `meta.wpm` → `130`.
- `wordCount` counts whitespace-delimited tokens after stripping SSML-ish markup (`sayAs`/`phoneme` payloads count as their spoken-form word count when known, else 1).
- `emphasis[]` does **not** change duration (it affects prosody, not pacing). Only `pause_ms_after` adds time in v1.

#### 5.4.2 Duration roll-up

```
phaseDuration   = Σ beatReadSeconds(beats in phase)        // or media clip length for fullscreen phases
sectionDuration = Σ phaseDuration + Σ (transition.dur)     // transitions add wall time
blockDuration   = Σ sectionDuration in block
breakDuration   = AdBreak.duration (default 120)
showDuration    = Σ sectionDuration + Σ breakDuration
```

#### 5.4.3 Soft-time vs hard-time

- **`softTime`** — *target* offset (s from show start). Advisory: drives the rundown UI's running-time column and producer warnings; the compiler does **not** stretch/compress to hit it. If actual cumulative duration drifts from `softTime` by more than `meta.softTimeToleranceSec` (default 15), emit `W_SOFT_TIME_DRIFT`.
- **`hardTime`** — *immovable* offset. The section is scheduled to **begin** at `hardTime`. Overrun is reconciled (§5.4.5).
- **`hardOut: true`** — the section must **end** at its `hardTime` (a hard-out).

#### 5.4.4 Back-timing

```
Given an anchor end time (showDuration target T_end, or a hardOut section):
  walk sections bottom-up:
    section.backTimedStart = nextSection.backTimedStart - section.sectionDuration - precedingBreakDuration
  topmost section's backTimedStart vs 0 (show start) = the over/under:
    overUnder = 0 - firstSection.backTimedStart
       overUnder > 0  → show is HEAVY (too long) by overUnder seconds
       overUnder < 0  → show is LIGHT (short)  by |overUnder| seconds
```

The compiler emits a `TimingReport` alongside the lowered doc:

```ts
export type TimingReport = {
  showDuration: number
  blocks: { block: 'A'|'B'|'C'|'D', duration: number }[]
  sections: {
    id: string, rundownIndex: number, block: 'A'|'B'|'C'|'D',
    start: number, duration: number,
    timingSource: 'measured'|'explicit'|'estimated',
    softTime?: number, softDrift?: number,
    hardTime?: number, hardViolation?: number   // >0 = overruns the hard point
  }[]
  overUnder: number           // + heavy / - light vs target
  warnings: string[]
};
```

#### 5.4.5 Kill / float / pad — overrun reconciliation

```ts
export const TimeFit = z.object({
  priority: z.number().int().min(1).default(5), // 1 = protect (never cut); higher = cuttable first
  kill: z.boolean().default(false),             // drop entirely if heavy
  float: z.boolean().default(false),            // movable: relocate to a later block or drop to next show
  pad: z.object({ min: z.number().min(0), max: z.number().min(0) }).optional(), // stretchable filler (sec) if LIGHT
});
```

Reconciliation when `overUnder > 0` (HEAVY) against a hard boundary:
```
1. Drop sections with timeFit.kill, descending priority order, until within tolerance.
2. Float-out sections with timeFit.float (move past the hard boundary), recomputing back-timing each step.
3. If still heavy and a hardOut exists, hard-truncate the LAST non-protected section's trailing beats
   (whole beats only — never mid-beat) and warn W_HARD_OUT_OVERRUN with residual.
4. Protected sections (priority 1 or anchored hardTime) are never trimmed; if still heavy,
   surface E_UNRESOLVABLE_HARD_OUT.
```
When `overUnder < 0` (LIGHT):
```
1. Expand pad sections within [min,max] proportionally to absorb the deficit.
2. If still light, extend the KICKER/sign-off music bed (Block D) and warn W_SHOW_LIGHT.
```
All trims are **deterministic** and reported in `TimingReport.warnings`; nothing is silently dropped. (`adBreakAfter` scheduling + kill/float/pad are **Later**.)

### 5.5 Sticky carry-forward (state model)

The performance is a **stateful machine** with Ren'Py-style carry-forward (the existing `compileManifest()` semantic): a property, once set, **persists** to every following beat/section until explicitly overridden or reset. This applies *across beats within a section and across section boundaries*, top-to-bottom.

#### 5.5.1 What carries (sticky channels)

| Channel | Source field(s) | Carry scope | Reset to |
|---|---|---|---|
| **camera** | `Section.cameraDefault`, `Beat.camera` (`CameraCue`) | beats + sections | last explicit cue (no auto-reset) |
| **look** | `NewsReportDoc.look`, `Section.lookOverride`, `Beat.lookOverride` | see scope rules | document `look` |
| **set / background** | `Section.set` (`mode` + `backScreen`) | beats + sections | previous section's `set` carries until a new `set` |
| **lighting** | `look`/lighting preset; avatar-live `lights{}` | beats + sections | document default |
| **music bed** | `AudioCue.kind:'bed'` | beats + sections + **across breaks** | next `bed` cue or explicit stop |
| **emotion** | `Beat.emotion` | beats within section; re-seeded per section default | section default / `neutral` |
| **gesture** | `Beat.gesture` | **does not carry** — one-shot per beat | n/a |
| **posture** | `Beat.posture` | beats + sections | document default / `neutral` |
| **gaze** | `Beat.gaze`, form default | beats within section | section/form default |

#### 5.5.2 Scope rules (sticky vs scoped)

- **Sticky override** (camera, set, music bed, posture, lighting, gaze): persists forward until the next override of the same channel. `Section.cameraDefault` is sticky — it continues into following sections unless they set their own.
- **Scoped override** (`lookOverride`): applies only within its owning scope and **reverts** at scope end.
  - `Beat.lookOverride` → that beat only; reverts to the section/document look on the next beat.
  - `Section.lookOverride` → the section's beats; reverts to `NewsReportDoc.look` at section end.

`emotion` is a hybrid: carries beat-to-beat **within** a section but is **re-seeded** to the section/form default at each new section. `gesture` never carries. `posture` carries fully.

#### 5.5.3 Explicit reset

```ts
export const Channel = z.enum(['camera','look','set','lighting','music','emotion','posture','gaze']);
// Beat.reset?:  Channel[]      — applied before the beat
// Section.reset?: Channel[]    — applied at section entry, before beats
```

Reset semantics per channel follow the "Reset to" column in §5.5.1 (e.g. `reset:['look']` → document `look`; `reset:['camera']` re-applies the section's `cameraDefault`, else the form default; `reset:['music']` stops the current bed).

#### 5.5.4 Compiler lowering of carry-forward

The compiler maintains a running **state vector** while walking beats in rundown order:

```ts
type CarryState = {
  camera: CameraCue; look: PostProcessingSpec; set: SectionSet;
  lighting: Lighting; musicBed?: AudioCue;
  emotion: Emotion; posture: Posture; gaze: Gaze;
};
```
At each beat: apply `Section.reset`/`Beat.reset` → merge sticky overrides into `CarryState` → emit the *resolved* (fully-specified) values onto the output cue/manifest entry. Downstream consumers (`ProjectDoc`/`Cue[]`, `PerformanceManifest`) receive **no implicit state** — every emitted cue is absolute, matching `compileManifest()`'s contract. Scoped (`lookOverride`) values merge for the emit and are popped at scope end. Full algorithm in [§7.1.2](#712-sticky-state-resolution-renpy-carry-forward).

### 5.6 Set modes

`Section.set.mode` (§4.9) selects the **staging environment** semantics. `backScreen` reuses the §2.7.1 vocab. Set carries forward (§5.5).

```ts
// SectionSet (§2.7): { mode: SetMode, backScreen?: BackScreen }
```

| mode | semantics | compile behavior |
|---|---|---|
| **`real`** | physical/real set; no synthetic environment. STANDUP (field) / on-location. | avatar-live: `studioOn=false`, `backScreen` shown as a plate if provided; engine-three: real-plate background, no virtual studio geometry. |
| **`chroma`** | green-screen key: the avatar is keyed over `backScreen`. | `backScreen.src` is the fill behind the keyed avatar; compiler marks `keyer:true`; no studio set. |
| **`virtual`** | full synthetic studio (default for desk forms). `backScreen` is the in-set monitor/video wall. | avatar-live: `studioOn=true`, `backScreen` drives the in-set wall (`cam.screen`/`cam.screenSource` work); engine-three: studio geometry + screen mesh. |
| **`LED`** | LED-volume / video-wall stage. Like `virtual` but the background is a physically-lit LED wall — affects lighting spill and parallax. | renderer treats `backScreen` as an emissive LED panel contributing to scene lighting; parallax tracking on if camera moves. |
| **`AR`** | augmented-reality graphics composited into a real/virtual set. | `backScreen` optional; AR `Graphic`s (`chart`/`map`/`still`) placed as 3D-anchored elements; compiler tags `arAnchored:true`. |

**Set + camera interaction:** `cam.screen`/`cam.screenSource` presets are only meaningful when `set.mode ∈ virtual|LED`. For `real`/`chroma`, a `cam.screen` cue degrades to `cam.wide` with `W_SCREEN_CAM_NO_SET`. For `AR`, screen-push cues target the largest AR panel if present, else degrade likewise.

**Set carry-forward:** consecutive `virtual` desk sections share the studio without re-declaring it; a `STANDUP` (`real`) section interrupts and the following section must re-declare `virtual` (or it inherits `real` — flagged `W_INHERITED_REAL_SET` when a desk-form `READER`/`VO` inherits a `real` set).

### 5.7 Compiler diagnostics (this section)

| Code | Level | Meaning |
|---|---|---|
| `E_EMPTY_SECTION` | error | section has no beats and no bumper graphic |
| `E_UNRESOLVABLE_HARD_OUT` | error | heavy show cannot make a hard-out without trimming protected content |
| `W_TRAILING_ADBREAK` | warn | `adBreakAfter` on the final section (ignored) |
| `W_SOFT_TIME_DRIFT` | warn | section start drifts from `softTime` beyond tolerance |
| `W_HARD_OUT_OVERRUN` | warn | content truncated to make a hard-out; residual reported |
| `W_SHOW_LIGHT` | warn | show under target after padding; kicker bed extended |
| `W_MOS_SINGLE` | warn | `MOS` section with a single soundbite |
| `W_SCREEN_CAM_NO_SET` | warn | screen-push camera used with `real`/`chroma` set |
| `W_INHERITED_REAL_SET` | warn | desk story-form inherited a `real` set via carry-forward |

All timing fields (`softTime`/`hardTime`/`hardOut`/`timeFit`) and the `TimingReport` are emitted into the lowered output so both backends and the rundown UI consume identical numbers.

---

## 6. Feature semantics — WRITER / DIRECTOR / PRODUCER (exhaustive)

This section enumerates every authorable feature. Each lists: **what it does**, the **canonical §2 field(s)**, **how it lowers/renders** to the two backends, and its **tier**. Throughout, "sticky carry-forward" is the §5.5 semantic. The three personas: **WRITER** authors `Beat.text` + per-beat performance; **DIRECTOR** authors `Beat.camera`/`Section.cameraDefault`/motion/staging/`Section.set`; **PRODUCER** authors `meta`/`brandKit`/`look`/`Section.graphics`/`Section.audio`/delivery.

> Field shapes are authoritative in §2; this section gives semantics + lowering and does not redefine types.

### 6.1 WRITER

**6.1.1 Spoken text** — `Beat.text`. One `Beat` → one `ScriptSegment` (`dsl.ts`), accumulated in `rundown` order. avatar-live: a `Cue{track:'narration', start, duration, text}`; engine-three: a `PerformanceManifest` line with TTS-measured `start`/`duration`. **MVP.**

**6.1.2 Emotion / gesture / posture per beat** — `Beat.emotion` (§4.1), `Beat.gesture` (§4.2), `Beat.posture` (§4.3). Copied into `ScriptSegment`. avatar-live: `emotion`→`setEmotion`; `gesture`→`Cue{track:'motion'}`→`motion.*`/`playClip`; `posture`→new static-pose API (§6.2.13). emotion/posture sticky, gesture one-shot. **emotion/gesture MVP; posture wiring V2.**

**6.1.3 Leveled emphasis** — `Beat.emphasis: Emphasis[]`, `Emphasis = {text, level: 'reduced'|'moderate'|'strong'}` (§2.8). Lowers to SSML `<emphasis level>` for SSML-capable TTS; Web Speech degrades to a micro-prosody bump. **flat (single level) MVP; leveled V2.**

**6.1.4 SSML: say-as / phoneme / prosody** — `Beat.sayAs: {text, as}[]` (`as` ∈ §2.8 enum), `Beat.phoneme: {text, ipa}[]`, `Beat.prosody: {rate?,pitch?,volume?}`. Lowers to SSML `<say-as>`/`<phoneme>`/`<prosody>` for the cloned-voice path; Web Speech: `prosody.rate/pitch`→`ProjectDoc.rate/pitch`, `sayAs`/`phoneme` normalized in-compiler before handing text to Web Speech. **V2.**

**6.1.5 Pause** — `Beat.pause_ms_after`. → `ScriptSegment.pause_ms_after`; contributes to the next beat's `Cue.start`. Avatar keeps sticky emotion/posture/idle during the hold. **MVP.**

**6.1.6 WPM pacing (auto-timing)** — `meta.fps` (frame grid) + `meta.wpm`/`Section.wpm` + per-beat `Beat.prosody.rate` (§5.4). Compiler computes `est_duration` for **preview** before TTS, then reconciles to measured at Record, frame-quantized to `meta.fps`. **V2** (MVP uses measured TTS timing only).

**6.1.7 Sections & story-forms (the rundown)** — `NewsReportDoc.rundown: Section[]`; `storyForm` (§4.6). Sections concatenate in order; boundaries become `transition`s (default `cut`) and carry-forward reset points. `storyForm` selects a staging/graphics template (§5.3). **basic `READER`/`VO` MVP**; full templates **V2→Later**; `block`/`adBreakAfter` scheduling **Later**.

**6.1.8 Package sub-grammar** — reporter **track**, **SOT** (`AudioCue{kind:'sot'}`), **natpop** (`AudioCue{kind:'natpop'}`), **standup** (a `track` beat staged on-camera, `set.mode:'real'`), and **outcue** (`AudioCue.outcue` or the final `track` beat). `Beat.blocking.speaker`/`turnId` group package beats; SOT/natpop → audio cues with ducking; `outcue` sets the section end + default transition. **V2** (`track`/`standup`/`outcue`); **Later** (`sot`/`natpop` clip time handling).

**6.1.9 Director-notes & boneyard** — `Beat.note` (`[[ … ]]`) and `Beat.omit` (`/* … */`). **Stripped** by the compiler — no `ScriptSegment`/`Cue`/manifest entry. Survive JSON↔`.ncast`↔builder round-trips for editor display. **MVP** (required for `.ncast` fidelity).

### 6.2 DIRECTOR

**6.2.1 Per-beat camera (semantic)** — `Beat.camera: CameraCue` (§2.6); `Section.cameraDefault`. Sticky carry-forward. avatar-live: `CameraCue`→`Cue{track:'camera', pose:[px,py,pz,tx,ty,tz,fov]}` (§4.10/§7.2.4); engine-three: cine-camera in `camera.ts`/`timeline.ts`. **MVP.**

**6.2.2 Named camera presets** — `CameraCue.preset` (§2.6, `cam.*` enum). In `.ncast`/builder a preset id resolves to a `CameraCue`/pose. Maps to `cam.enterLeft, cam.wide, cam.anchor, cam.close, cam.screen, cam.orbit, cam.custom, cam.path, cam.screenSource`. **MVP.**

**6.2.3 Captured pose / path** — `CameraCue.pose` (7-tuple) overrides semantic shot/target; `CameraCue.path: Pose[]` multi-keyframe (with `preset:'cam.path'`). `pose`→`Cue{track:'camera', pose}`; `path`→`Cue{track:'camera', path}` sampled across the beat. **`pose` MVP; `path` V2.**

**6.2.4 Avatar motion** — via `Beat.gesture` (§4.2) and `Beat.blocking` (§6.2.10); idle via `defaults.idleMotion`/`ProjectDoc.idleMotion`. → `Cue{track:'motion'}`→`motion.*`/`playClip` body clips. **MVP** (gesture/idle); richer blocking V2.

**6.2.5 Transitions** — `Beat.transition {type, dur}`, `type` ∈ §4.8. Section boundaries default `cut`. Render-stage cue: avatar-live cross-fade/dip-to-black in SP-1; `defocus` via DoF ramp; `wipe` via shader. **`cut` MVP; `dissolve`/`fade` V2; `wipe`/`defocus` V2→Later.**

**6.2.6 Vision-mixer screen cut** — `Section.set.backScreen` (default) overridden per beat via `Beat.blocking.mark`/a `Graphic{kind:'OTS'|'fullscreen'}` with `at`/`out`. Updates the back-screen texture at cue time; `cam.screenSource` reframes to it. **V2.**

**6.2.7 Shot-size + angle + focus grammar** — `CameraCue.shot` (size, §4.7.1), `CameraCue.angle` (`eye|low|high|dutch`, §2.6), `CameraCue.focus {distance?,bokeh?}` (ties to `look.dof`). `angle` offsets pose pitch/roll; `focus` feeds `look.effects.dof`. **`shot` MVP; `angle`/`focus` V2.**

**6.2.8 Multi-camera registry + TAKE switching** — `meta.cameras` (registry) + `Beat`-level take selection. **Later** (not in the §2 MVP schema; added when scheduled).

**6.2.9 Eyeline / gaze targets** — `Beat.gaze ∈ camera|coAnchor|monitor` (§2.8). New API `setGazeTarget(target)`. Sticky. **V2** (`camera`/`monitor`); `coAnchor` **Later** (needs two-shot).

**6.2.10 Blocking** — `Beat.blocking {position?, turn?, headTilt?, mark?, idleMotion?, speaker?}` (§2.8). `position`→`setPosition`; `turn`→`setTurn`; `headTilt`→`setHeadTilt`; `mark` named stage position. Sticky. **V2.**

**6.2.11 Two-shot / OTS staging (multi-avatar)** — `meta.anchors[]` + `Beat.anchorId`/`Section.anchorId` + `Beat.blocking.mark` + `Graphic{kind:'OTS'}`. Instantiates a second avatar from the second `Anchor.avatarUrl`. **Later.**

**6.2.12 Set modes** — `Section.set.mode` (§4.9/§5.6), `Section.set.backScreen`. avatar-live toggles `ProjectDoc.studioOn` + background; engine-three swaps the environment node. Sticky. **`real`/`virtual` + back-screen MVP; `chroma`/`LED`/`AR` V2→Later.**

**6.2.13 New avatar APIs** — additive to `avatarController`: `setHeadTilt(pitch, roll)`, `nod(times?, amplitude?)`, `setEmotion(name, intensity, {crossfadeMs})`, `setPose(posture)` (static pose without clip), `setGazeTarget(target)`, `setBlink('force'|'suppress'|'auto')`. Driven by `Beat.gesture:'nod'`, `Beat.posture`, `Beat.emotion` change, `Beat.gaze`, `Beat.blocking.turn/headTilt`. **head tilt/nod + emotion cross-fade + static-pose + gaze + blink: V2** (the "GAPS (must add)").

### 6.3 PRODUCER

**6.3.1 Headline / chyron** — `Graphic{kind:'lowerThird'}` for named straps, or `ProjectDoc.headline` carry for the running headline. Styled by `brandKit.lowerThirdStyle`. **simple `headline` MVP; styled chyron V2.**

**6.3.2 Lighting: preset + channels + exposure/warmth** — `defaults.lights`/`Section.lights` (`Lighting` type below), mirroring avatar-live `ProjectDoc.lights{key,fill,rim,ambient,exposure,warmth,preset}`:
```ts
export const Lighting = z.object({
  preset: z.enum(['studio','soft','dramatic','warm','cool']).default('studio'),
  key: z.number().min(0).max(2).default(1), fill: z.number().min(0).max(2).default(0.6),
  rim: z.number().min(0).max(2).default(0.4), ambient: z.number().min(0).max(2).default(0.3),
  exposure: z.number().min(0).max(4).default(1), warmth: z.number().min(-1).max(1).default(0),
});
```
Interacts with §8.2 tone-mapping (`look.effects.toneMapping.exposure` wins if a `look` override is present). Sticky/section-scoped. **MVP.**

**6.3.3 Back-screen** — `Section.set.backScreen = {kind, src, fit, loop, mute}` (§2.7.1), `kind ∈ none|color|image|video|stream|chart`. Texture on the back-screen/LED plane; `video`/`stream` play on the frame clock (sampled per `VideoFrame` in SP-1). **`image`/`video`/`color` MVP; `stream` (live) Later.**

**6.3.4 Music bed + sfx + natpop + sot, with fades + ducking** — `Section.audio: AudioCue[]` (§2.10); `brandKit.musicBed`. Each → avatar-live `Cue{track:'audio', src, volume, fadeIn, fadeOut}`. SP-1 mixes all tracks + TTS voice into one `AudioBuffer` → Mediabunny `AudioBufferSource` (fixes Web-Speech no-audio). `duck.amount` sidechains the bed under voice. **`bed` + fades + `sfx` MVP; ducking V2; `natpop`/`sot` V2→Later.**

**6.3.5 Lower-thirds / name-straps** — `Graphic{kind:'lowerThird', title, subtitle?, style?}` (§2.9), styled by `brandKit.lowerThirdStyle`; auto-populated from the active `Anchor`. Timed overlay (`at`/`out`, `anim`). **V2.**

**6.3.6 Fullscreen GFX / OTS / stills / charts / maps** — `Graphic.kind ∈ fullscreen|OTS|still|chart|map` (§2.9). `fullscreen`/`still`→full quad; `OTS`→boxed beside the anchor; `chart`/`map`→rendered to texture then composited. **`fullscreen`/`still` MVP; `OTS`/`chart`/`map` Later** (per §2.9 tiers).

**6.3.7 Ticker / crawl / bug** — `Graphic{kind:'ticker', items[], speed, position}`, `Graphic{kind:'bug', src, corner, opacity}`. Show-wide bug from `brandKit.logo`. Persistent overlay layers. **`ticker`/`bug` V2.**

**6.3.8 Brand kit** — `brandKit = {palette, fonts, logo, lowerThirdStyle, safeAreas, musicBed?}` (§2.3). Supplies defaults to all graphics, the bug, the bed, safe-area overlays. Pure defaulting. **Later.**

**6.3.9 Stingers / bumpers / open / credits** — `Graphic{kind:'bumper', src, audioSrc?}` for stingers/bumpers; show **open** = a `bumper` at the head of the first section; **credits** = a `bumper`/`fullscreen` at the tail. Often paired with an `AudioCue{kind:'sfx'}` sting. **bumper V2; full open/credits sequences Later.**

**6.3.10 Captions 608/708 + dirty/clean** — `meta.captions = CaptionsSpec {enabled, mode, standard, cleanFeed}` (§2.12). Captions from `Beat.text` + measured TTS timing → WebVTT sidecar and/or burned-in. `cleanFeed:true` produces a textless master. **Later.**

**6.3.11 Ad-break + sponsor** — `Section.adBreakAfter` (bool/`AdBreak`), `Section.block`, `Section.softTime`/`hardTime` (§5.2/§5.4), `Graphic{kind:'bumper'}` sponsor billboard. MVP: marker only. **Later** (full soft/hard/kill/float/pad scheduling).

**6.3.12 Look / filters (post-processing)** — `NewsReportDoc.look: PostProcessingSpec` (§2.11), `Section.lookOverride`, `Beat.lookOverride`. pmndrs `postprocessing` `EffectComposer` after the main render (§8.2 pipeline order); `renderer` `NoToneMapping`. Sticky carry-forward of `look`; `lookOverride` merges over the running look. **default `broadcast` + core effects MVP (SP-2); per-section/beat `lookOverride` + `dof`/`chromaticAberration`/`noir` V2; `neutral-agx` Later.**

**6.3.13 Delivery (resolution / aspect / codec / safe-areas)** — render-request `{format: CaptureFormat, fps: meta.fps, codec?: 'avc1'|'hvc1', tier?: 'browser'|'premium', safeAreas?}` (§4.15/§8.1). SP-1 in-browser: Worker + OffscreenCanvas + WebCodecs + Mediabunny; `t=i/fps`; WebM fallback. `tier:'premium'` → `services/gpu/finishing` (GFPGAN→Real-ESRGAN×4→RIFE→libx264 CRF16+AAC; parameterize the hardcoded 1080 target; H100 has NO NVENC). **6 resolutions + `avc1` + browser tier MVP; `hvc1` MVP-if-supported; `premium` V2; safe-area guides V2.**

**6.3.14 B-roll / sequences / slow-mo / freeze / replay** — back-screen/fullscreen `src` + a time-map on the clip. Drives the clip playhead on the frame clock; `speed<1`=slow-mo (RIFE in premium), `freezeAt` holds a frame, replay re-issues with a "REPLAY" `bug`. **Later** (depends on solid back-screen video + SP-1 frame sampling).

### 6.4 Tier summary (this section)

| Tier | Features |
|---|---|
| **MVP** | text; emotion/gesture; pause; single-level emphasis; basic `READER`/`VO` rundown; director-notes/boneyard; per-beat camera + named presets + captured `pose`; avatar gesture/idle motion; `cut`; `real`/`virtual` set + back-screen (image/video/color); simple headline; lighting preset+channels+exposure/warmth; music bed+fades+sfx; default `broadcast` look (SP-2 core); 6 resolutions + `avc1`/`hvc1` browser delivery |
| **V2** | leveled emphasis; SSML (say-as/phoneme/prosody); WPM pacing; posture wiring; package `track`/`standup`/`outcue`; `dissolve`/`fade`; vision-mixer screen cut; angle/focus grammar; gaze (`camera`/`monitor`); blocking; head tilt/nod + emotion cross-fade + static-pose + blink (new avatar APIs); chroma/LED set; styled chyron; ducking; lower-thirds; ticker/bug/bumper; per-section/beat `lookOverride` + `dof`/`chromaticAberration`; premium finishing tier; safe-area guides |
| **Later** | full story-form templates (`VOSOT/PKG/DONUT/MOS/STANDUP/KICKER`); block/ad-break scheduling (soft/hard/kill/float/pad); `sot`/`natpop` clip handling; multi-camera registry + TAKE switching; `coAnchor` gaze; two-shot/OTS multi-avatar; `stream` back-screen; charts/maps; OTS; brand kit; open/credits sequences; captions 608/708 + dirty/clean; sponsor billboards; B-roll/slow-mo/freeze/replay; `wipe`/`defocus` transitions; `AR` set; `neutral-agx` look |

---

## 7. Compile / lowering rules + import & Record runtime flow

This section defines the deterministic transformation from the canonical `NewsReportDoc` (v2) into the two render backends, the import discriminator, and the end-to-end Record flow. Everything is **pure and deterministic**: same `NewsReportDoc` + same TTS timing → byte-identical `ProjectDoc`/`Cue[]` and `EngineRenderSpec`/`PerformanceManifest`. No `Math.random`, no `Date.now`, no `rAF`-derived state.

### 7.0 Compiler topology

```
                         ┌─────────────────────────────┐
   NewsReportDoc (v2)    │  validateNewsReport (zod)    │
   ───────────────────▶  │  → CompileContext (resolved  │
                         │     sticky state, timing)    │
                         └──────────────┬──────────────┘
                                        │
                 ┌──────────────────────┴───────────────────────┐
                 ▼                                               ▼
   (A) compileToAvatarLive(ctx)                    (B) compileToEngineThree(ctx)
   → { project: ProjectDoc,                        → { spec: EngineRenderSpec,
       cues: Cue[],                                     manifest: PerformanceManifest }
       look: PostProcessingSpec }                  (reuses compileManifest())
```

Both backends consume **one shared front half**: `validateNewsReport()` → `buildCompileContext()`. The context owns the single source of truth for timing and sticky-state resolution, so the two backends never diverge.

#### 7.0.1 Module placement

| Module | Path | Tier |
|---|---|---|
| `validateNewsReport` | `packages/protocol/src/newsreport.ts` (zod schema + parse) | MVP |
| `buildCompileContext` | `packages/protocol/src/compile/context.ts` | MVP |
| `compileToAvatarLive` | `apps/avatar-live/src/compile/toProjectDoc.ts` | MVP |
| `compileToEngineThree` | `packages/protocol/src/compile/toEngineSpec.ts` (extends `manifest.ts`) | MVP |
| `parseNcast` | `packages/protocol/src/ncast/parse.ts` (.ncast text → `NewsReportDoc`) | V2 |

`NewsReportDoc`, `PostProcessingSpec`, `Section`, `Beat`, `Graphic`, `AudioCue` zod schemas live in `packages/protocol` (§2) and regenerate JSON-Schema via `npm run protocol:schema`.

### 7.1 The CompileContext (resolved intermediate)

The context linearizes the rundown, resolves all sticky state into per-beat explicit values, and attaches timing.

```ts
interface CompileContext {
  doc: NewsReportDoc;
  fps: number;                       // meta.fps ?? 30
  aspect: string;                    // meta.aspect ?? '16:9'
  flat: FlatBeat[];                  // flattened, ad-breaks resolved, in performance order
  baseLook: PostProcessingSpec;      // doc.look ?? lookPreset('broadcast')
  timing?: BeatTiming[];             // index-aligned to flat[]; filled after TTS (§7.6)
  timingReport?: TimingReport;       // §5.4.4
}

interface FlatBeat {
  sectionId: string; sectionIndex: number; beatIndex: number; beat: Beat;
  resolved: {                        // RESOLVED sticky state (never undefined after resolution):
    anchorId: string;                // Beat → Section.anchorId → meta.anchors[0].id
    emotion: Emotion;                // sticky carry-forward
    gesture: Gesture;                // beats default 'none' (NOT sticky — §7.4.2)
    posture: Posture;                // sticky
    gaze: Gaze;                      // sticky, default 'camera'
    camera: CameraCue;               // sticky shot/move/target/easing/intensity (field-wise merge)
    set: SectionSet;                 // sticky set.mode + backScreen
    look: PostProcessingSpec;        // baseLook ⊕ section.lookOverride ⊕ beat.lookOverride
    blocking?: Blocking;             // sticky
  };
}
```

#### 7.1.1 Rundown flattening + ad-breaks

```ts
function flattenRundown(doc): FlatBeat[] {
  const out: FlatBeat[] = [];
  doc.rundown.forEach((section, sIdx) => {
    section.beats.forEach((beat, bIdx) =>
      out.push({ sectionId: section.id, sectionIndex: sIdx,
                 beatIndex: bIdx, beat, resolved: /* §7.1.2 */ }));
    // MVP: adBreakAfter → inject a 'bumper' graphic + bed audio gap marker.
    // Later: real ad-slot scheduling (soft/hard/kill/float/pad, §5.4.5).
    if (section.adBreakAfter) out.push(makeAdBreakMarker(section));
  });
  return out;
}
```

#### 7.1.2 Sticky-state resolution (Ren'Py carry-forward)

Resolved **left-to-right across the entire flattened rundown** (carries *across* sections unless a section overrides). Same semantics as `compileManifest()`'s STICKY CARRY-FORWARD, extended to `set`, `look`, `gaze`, `blocking` (§5.5).

```ts
function resolveSticky(flat: FlatBeat[], doc, ctx): void {
  let cur = {
    emotion: doc.defaults?.emotion ?? 'neutral',
    posture: doc.defaults?.posture ?? 'neutral',
    gaze:    doc.defaults?.gaze ?? 'camera',
    camera:  doc.defaults?.camera ?? DEFAULT_CAMERA, // medium/static/face/ease_in_out/0.5
    set:     doc.defaults?.set       ?? { mode: 'virtual' },
    gesture: 'none' as Gesture,
    blocking: undefined as Blocking | undefined,
  };
  let curSectionId: string | null = null;

  for (const fb of flat) {
    const section = doc.rundown[fb.sectionIndex];

    // (1) On a NEW section: apply Section.reset, then section-level overrides BEFORE its beats.
    if (section.id !== curSectionId) {
      applyResets(cur, section.reset, doc);
      if (section.cameraDefault) cur.camera = mergeCamera(cur.camera, section.cameraDefault);
      if (section.set)           cur.set    = mergeSet(cur.set, section.set);
      cur.emotion = doc.defaults?.emotion ?? 'neutral'; // emotion re-seeds per section
      curSectionId = section.id;
    }

    const b = fb.beat;
    applyResets(cur, b.reset, doc);
    if (b.emotion)  cur.emotion  = b.emotion;          // sticky within section
    if (b.posture)  cur.posture  = b.posture;          // sticky
    if (b.gaze)     cur.gaze     = b.gaze;             // sticky
    if (b.camera)   cur.camera   = mergeCamera(cur.camera, b.camera); // sticky, field-wise merge
    if (b.blocking) cur.blocking = b.blocking;         // sticky

    fb.resolved = {
      anchorId: b.anchorId ?? section.anchorId ?? doc.meta.anchors[0].id,
      emotion:  cur.emotion,
      gesture:  b.gesture ?? 'none',                   // NON-sticky: defaults each beat
      posture:  cur.posture,
      gaze:     cur.gaze,
      camera:   { ...cur.camera },                     // snapshot
      set:      { ...cur.set },                        // snapshot
      look:     mergeLook(ctx.baseLook, section.lookOverride, b.lookOverride), // scoped
      blocking: cur.blocking,
    };
  }
}
```

**Resolution rules:**

| Field | Sticky? | Default source | Merge |
|---|---|---|---|
| `emotion` | ✅ within section (re-seed per section) | `defaults.emotion`→`neutral` | replace |
| `posture` | ✅ carry | `defaults.posture`→`neutral` | replace |
| `gaze` | ✅ carry | `defaults.gaze`→`camera` | replace |
| `camera` | ✅ carry | `defaults.camera`→`DEFAULT_CAMERA` | **field-wise merge** |
| `set` | ✅ carry | `defaults.set`→`{mode:'virtual'}` | field-wise merge |
| `look` | scoped | `doc.look`→`broadcast` | **deep merge** base⊕section⊕beat, popped at scope end |
| `blocking` | ✅ carry | none | replace |
| `gesture` | ❌ per-beat | `none` | replace, reset each beat |
| `emphasis`/`sayAs`/`phoneme`/`prosody`/`pause_ms_after`/`transition` | ❌ per-beat | per-field | per-beat |
| `anchorId` | ❌ resolved | section → meta | resolved, not carried |

> **Camera field-wise merge:** a beat that sets only `{move:'dolly_in'}` keeps the sticky `shot`/`target`/`easing`. **Look deep merge:** a beat can tweak one effect without discarding the inherited grade/vignette.

> **DEFAULT_CAMERA** = `{shot:'medium', move:'static', target:'face', easing:'ease_in_out', intensity:0.5}` (matches §2.4/§2.6 defaults).

### 7.2 (A) Lowering NewsReportDoc → avatar-live ProjectDoc + Cue[]

`compileToAvatarLive(ctx)` → `{ project: ProjectDoc, cues: Cue[], look: PostProcessingSpec }`.

#### 7.2.1 Doc-level → ProjectDoc scalar fields

| ProjectDoc field | Source | Rule |
|---|---|---|
| `version` | — | compiler stamps current ProjectDoc version |
| `name` | `meta.title` | direct |
| `script` | `flat[]` beats | `Script = {version, language: meta.language, segments}`; each `FlatBeat`→`ScriptSegment` (§7.2.2) |
| `voiceId` | `meta.anchors[resolved.anchorId].voiceId` | first beat's anchor (multi-anchor Later) |
| `rate` | `defaults.prosody.rate` ?? anchor `rate` | global; per-beat via `prosody` on segments |
| `pitch` | `defaults.prosody.pitch` ?? anchor `pitch` | global |
| `emotion` | `flat[0].resolved.emotion` | initial; per-beat via cues |
| `avatarUrl` | `meta.anchors[0].avatarUrl` | first anchor |
| `shot` | `flat[0].resolved.camera.shot` | initial camera preset (§7.2.4) |
| `studioOn` | `flat[0].resolved.set.mode !== 'real'` | virtual/chroma/LED/AR ⇒ on |
| `idleMotion` | `defaults.idleMotion` ?? `'idle_calm'` | body clip |
| `headline` | first `lowerThird`/`fullscreen` title, else `meta.title` | seed; graphic cues drive the rest |
| `lights` | `look`→lighting bridge + `defaults.lights` | §7.2.6 |
| `backScreen` | `flat[0].resolved.set.backScreen` | `{kind,src}` or `null` |
| `timeline` | `{duration, cues}` | `duration`=Σ beat durations (§7.6); `cues`=compiled `Cue[]` |

#### 7.2.2 Beat → ScriptSegment

```ts
function beatToSegment(fb: FlatBeat, seq: number): ScriptSegment {
  const r = fb.resolved, b = fb.beat;
  return {
    seq, turnId: `${fb.sectionId}:${fb.beatIndex}`,
    text: applySayAs(b.text, b.sayAs, b.phoneme),  // SSML lowering, V2; MVP = plain text
    emotion: r.emotion, gesture: r.gesture, posture: r.posture,
    emphasis: b.emphasis ?? [],
    pause_ms_after: b.pause_ms_after ?? doc.defaults?.pause_ms_after ?? 0,
    camera: r.camera,                              // CameraCue (sticky resolved)
  };
}
```

This `Script` also feeds backend (B) via `compileManifest()` — single spine, two consumers.

#### 7.2.3 Beat → Cue[] fan-out

After timing (§7.6) gives `start`/`duration`, emit cues onto four tracks. **A beat is a cluster of cues** sharing a time window. The **sticky → explicit-edge rule** (camera/look/set/motion): emit a cue on a track **only at the beat where the resolved value differs from the previous beat's**, turning carry-forward into a minimal, frame-exact cue list. Narration always emits one cue per beat.

```ts
function beatToCues(fb, t /*BeatTiming*/, prev): Cue[] {
  const r = fb.resolved, b = fb.beat, out: Cue[] = [];
  const baseId = `${fb.sectionId}.${fb.beatIndex}`;
  // (1) NARRATION — always one per beat.
  out.push({ id: `${baseId}.nar`, track: 'narration', type: 'speak',
    start: t.start, duration: t.speakDuration, text: b.text,
    emotion: r.emotion, gesture: r.gesture, label: `${fb.sectionId} · beat ${fb.beatIndex}` });
  // (2) CAMERA — only on change edge.
  if (cameraChanged(prev?.camera, r.camera))
    out.push({ id: `${baseId}.cam`, track: 'camera', type: cameraTypeFor(r.camera),
      start: t.start, duration: cameraMoveDuration(r.camera, t),
      pose: poseForShot(r.camera, r.set), path: pathFor(r.camera), label: `${r.camera.shot}/${r.camera.move}` });
  // (3) MOTION — gesture + gaze + posture + blocking change edges (§7.2.5).
  for (const m of motionCuesFor(r, prev, baseId, t)) out.push(m);
  return out;
}
// (4) AUDIO + (5) GRAPHIC: emitted at section scope (§7.2.7, §7.2.8).
```

#### 7.2.4 CameraCue → avatar-live camera preset (`cam.*`)

| protocol `shot` | base preset | notes |
|---|---|---|
| `wide` | `cam.wide` | full studio |
| `full` | `cam.wide` (tightened) | |
| `medium` | `cam.anchor` | default newsread |
| `medium_close` | `cam.anchor` (tighter fov) | |
| `close_up` | `cam.close` | |
| `extreme_close_up` | `cam.close` (min fov) | |

| protocol `move` | cue behavior |
|---|---|
| `static` | static pose, `duration`=0 (snap) or crossfade `transition.dur` |
| `dolly_in`/`dolly_out` | `cam.custom`, start→end `pose` along view axis |
| `truck_left`/`truck_right` | `cam.custom` lateral translate |
| `pan_left`/`pan_right` | `cam.custom` target yaw |
| `pedestal_up`/`pedestal_down` | `cam.custom` vertical translate |
| `orbit_left`/`orbit_right` | `cam.orbit` with `path` arc; sign=direction |

`target`→`[tx,ty,tz]` look-at; `easing`→cue easing; `intensity`→move magnitude/fov delta; `set.backScreen` + screen-target ⇒ `cam.screen`/`cam.screenSource`. `pose` is always the absolute 7-tuple (determinism — the performer never recomputes presets at record time). Full vocab reconciliation: [§4.10](#410-camera-vocab-reconciliation-canonical--avatar-live--engine-three).

#### 7.2.5 Resolved performance state → motion cues (`motion.*`)

Emit on change edges:

| resolved change | motion cue(s) |
|---|---|
| `gesture: wave` | `motion.wave` (→ `talk5`) |
| `gesture: point` | `motion.point` (→ `talk3`; uses `blocking`/target) |
| `gesture: nod` | `motion.nod` |
| `gesture: explain`/`open_palms`/`count`/`shrug`/`thumbs_up`/`hand_to_chest` | `motion.explain` (→ `talk1`; MVP collapses to nearest existing clip; GAP: dedicated clips V2) |
| `gaze: monitor` (was camera) | `motion.turnScreen` |
| `gaze: camera` (was monitor/coAnchor) | `motion.faceFront` |
| `gaze: coAnchor` | `motion.turnScreen` toward co-anchor seat (Later) |
| `posture` change | static-pose via avatarController (GAP: static-pose-without-clip + head tilt) |
| `blocking` change | `motion.*` position/turn (`setPosition`/`setTurn`/`setHeadTilt`) |

> **avatarController GAPS surfaced by lowering** (must add for full fidelity): head tilt/nod, emotion cross-fade, static-pose-without-clip (posture), gaze targets, blink force/suppress. Until added, the compiler emits the cue but the performer **no-ops gracefully** (logs a warning, never throws).

#### 7.2.6 look / lighting bridge

`look` drives **two** outputs:
1. **`project.lights`** preset chosen from `look.preset` + `look.effects.grade.temperature`:

   | `look.preset` | `lights.preset` | exposure / warmth |
   |---|---|---|
   | `broadcast`/`neutral-agx` | `studio` | exposure from `toneMapping.exposure`, warmth from `grade.temperature` |
   | `cinematic` | `dramatic` | lower fill, higher rim |
   | `warm` | `warm` | warmth↑ |
   | `cool` | `cool` | warmth↓ |
   | `noir` | `dramatic` | high contrast, low fill |
   | `none` | `soft` | neutral |

   Explicit `defaults.lights`/`Section.lights` **override** the bridge.
2. **`look` (returned separately)** — the full `PostProcessingSpec` to the SP-2 `EffectComposer`. Per-beat `lookOverride` → a `look`-change edge; performer tweens across `transition.dur` (Later: animated look transitions; MVP: snap at beat boundary).

#### 7.2.7 AudioCue lowering → audio track

```ts
{ id, track: 'audio', type: kindToType(kind), // bed|sfx|natpop|sot
  start: sectionStart + cue.start, duration: cue.duration,
  src: cue.src, volume: cue.volume, fadeIn: cue.fadeIn, fadeOut: cue.fadeOut }
```
- `brandKit.musicBed` → a single `bed` cue spanning `[0, timeline.duration]`, lowest volume.
- `duck:{target:'voice', amount}` (V2): lower bed/sfx volume by `amount` during overlapping `narration` cues (output gain = `volume*(1-amount)`, 120 ms attack / 250 ms release). MVP ignores `duck`.
- All audio mixed into the SP-1 `AudioBuffer`.

#### 7.2.8 Graphic lowering → project.graphics + graphic cues

Avatar-live renders graphics as a DOM/canvas overlay from `project.graphics[]` (new additive field). Lowering by `kind` (canonical §2.9):

| `Graphic.kind` | lowering | tier |
|---|---|---|
| `lowerThird` | overlay `at`/`out`, `anim` in/out; first seeds `project.headline` | V2 |
| `fullscreen`/`still` | full-frame image; pairs with `VO`/`PKG` | MVP |
| `bug` | persistent corner logo (from `brandKit.logo`) | V2 |
| `ticker` | scrolling lower strip | V2 |
| `bumper` | full-frame transition card (also from ad-breaks) | V2 |
| `OTS` | over-the-shoulder box (needs two-shot) | Later |
| `chart`/`map` | data graphic render | Later |

`at`/`out` resolved against section/beat timing; `anim`→in/out transition. `bug` is sticky (persists until removed); `lowerThird` auto-outs at `out`.

#### 7.2.9 storyForm influence

`storyForm` adjusts default framing/graphics, not new tracks (§5.3). It only **sets defaults** the resolver/sticky logic then carries; explicit beat fields win.

### 7.3 (B) Lowering NewsReportDoc → engine-three EngineRenderSpec / PerformanceManifest

`compileToEngineThree(ctx)` **reuses `compileManifest()`**.

#### 7.3.1 Reuse path

```ts
function compileToEngineThree(ctx): { spec: EngineRenderSpec; manifest: PerformanceManifest } {
  const script: Script = { version, language: ctx.doc.meta.language,
                           segments: ctx.flat.map(beatToSegment) };   // same spine as (A)
  const manifest = compileManifest({ script, ttsTiming: ctx.timing, scene }); // Ren'Py sticky ✅ reuse
  // EXTEND manifest with newsroom dimensions (all optional → old pods ignore):
  manifest.look     = ctx.baseLook;                    // PostProcessingSpec (SP-2)
  manifest.graphics = lowerGraphicsToManifest(ctx);    // overlay track
  manifest.audio    = lowerAudioToManifest(ctx);       // bed/sfx/natpop/sot
  manifest.rundown  = ctx.doc.rundown.map(toSectionMeta); // section boundaries, storyForm
  manifest.set      = perBeatSetTrack(ctx);            // set.mode + backScreen edges
  const spec: EngineRenderSpec = {
    ...baseSpec, scene: sceneDoc, look: ctx.baseLook,
    fps: ctx.fps, aspect: ctx.aspect, captureFormat: ctx.doc.meta.captureFormat ?? '1080p',
  };
  return { spec, manifest };
}
```

#### 7.3.2 Protocol additions (regenerate JSON-Schema)

- `PostProcessingSpec` → `scene.ts` and `EngineRenderSpec` (SP-2).
- `PerformanceManifest` gains optional `look`, `graphics[]`, `audio[]`, `rundown[]`, `set[]` (all optional → old pods ignore, no break).
- New `NewsReportDoc` schema (§2). Run `npm run protocol:schema`.

#### 7.3.3 WYSIWYG carry-through

When `EngineRenderSpec.scene` + `.look` are set, the pod's `setupEditorScene()` applies the frozen camera **and** builds the SP-2 float-RT `EffectComposer` (validated in headless `gl`/Xvfb per §8.2.6 *before* wiring). Graphics/audio/rundown from `manifest` are composited headless. Old pods fall back to placeholder/no-look (the stale-binary failure mode) — `/engine-three/health` must report `wysiwygScene:true`, `look:true`, `postFx:true`.

#### 7.3.4 Parity guarantee

Both backends MUST agree on beat order, per-beat resolved emotion/gesture/posture/camera/set/look, and timing. Enforced by a shared snapshot test diffing `compileToAvatarLive` cues vs `compileToEngineThree` manifest for state-at-time-t equivalence (protocol vitest, alongside `manifest.test.ts`).

### 7.4 Determinism & timing discipline

#### 7.4.1 Timing model (SP-1)

```ts
interface BeatTiming {
  start: number;        // seconds, = Σ prior (speakDuration + pause)
  speakDuration: number;// from TTS word/phoneme timing (MVP: per-segment audio length)
  pauseAfter: number;   // beat.pause_ms_after / 1000
}
// frame index drives the clock: frameTime(i) = i / fps   (NOT rAF)
```
Timing computed **once** post-TTS, frozen into `ctx.timing`. Both backends read it. WPM auto-timing (V2) estimates pre-TTS, replaced at Record. `transition.dur` and graphic `at`/`out` quantized to frame boundaries: `round(t*fps)/fps`.

#### 7.4.2 Gesture is per-beat; emotion/posture/camera/set/look are sticky

This asymmetry (§7.1.2) is intentional and holds in both backends: a one-off `wave` does not persist; a `serious` emotion or `close_up` camera persists until changed.

### 7.5 Import discriminator (projectStore)

The existing `timelineFileEl` handler is extended with a **discriminator** (most specific first):

```ts
async function importFile(input: unknown, filename: string): Promise<ProjectDoc> {
  // 1. .ncast text — by extension or leading ---/#/:: header.
  if (filename.endsWith('.ncast') || isNcastText(input)) {       // V2
    const { doc } = parseNcast(input as string);                 // → NewsReportDoc
    return compileAndAdopt(doc);
  }
  const json = typeof input === 'string' ? JSON.parse(input) : input;
  // 2a. NewsReportDoc v2.
  if (json?.version === 2 && json.meta && Array.isArray(json.rundown)) {
    return compileAndAdopt(validateNewsReport(json));            // zod → throws ZodError (§7.7)
  }
  // 2b. Legacy ProjectDoc.
  if (json?.script && json?.voiceId && json?.timeline) return validateProjectDoc(json);
  // 2c. Bare timeline export.
  if (Array.isArray(json?.cues) && typeof json?.duration === 'number') return mergeTimelineIntoCurrentProject(json);
  throw new ImportError('Unrecognized document', { filename, hint: detectShape(json) });
}

function compileAndAdopt(doc: NewsReportDoc): ProjectDoc {
  const ctx = buildCompileContext(doc);          // pre-TTS: estimated timing (WPM)
  const { project, cues, look } = compileToAvatarLive(ctx);
  projectStore.sourceDoc = doc;                  // stash for re-compile at Record (real TTS timing)
  projectStore.look = look;
  return { ...project, timeline: { ...project.timeline, cues } };
}
```

| Shape | Signature | Action |
|---|---|---|
| `.ncast` | extension `.ncast` or `---`/`#`/`::` header | `parseNcast` → compile |
| `NewsReportDoc` v2 | `version===2 && meta && Array.isArray(rundown)` | `validateNewsReport` → compile |
| legacy `ProjectDoc` | `script && voiceId && timeline` (no `rundown`) | adopt directly |
| bare timeline | `Array.isArray(cues) && typeof duration==='number'` | merge into current |
| unknown | none match | `ImportError` with shape hint |

The source `NewsReportDoc` is retained (`projectStore.sourceDoc`) so Record re-compiles with real TTS timing.

### 7.6 RECORD runtime flow

Record re-compiles from `sourceDoc` (if present) so the MP4 uses exact TTS timing.

```
RECORD()  =
  1. VALIDATE      sourceDoc → validateNewsReport (zod)         [throws → §7.7]
  2. TTS           synthesize per-segment audio + word timing   [server voice clone]
  3. BUILD CONTEXT buildCompileContext(doc, ttsTiming)          [freezes ctx.timing]
  4. COMPILE       compileToAvatarLive(ctx) → {project,cues,look}
  5. APPLY         applyProject(project)  → configures editor   [avatarUrl,lights,set,shot…]
  6. PRELOAD       fetch all audio/graphic/clip assets; decode  [no network during perform]
  7. PERFORM       frame-exact offline render (SP-1) + look (SP-2)
  8. DELIVER       client MP4  (default)  OR  premium master (server, opt-in)
```

**1. Validate** — on failure, surface ZodError (§7.7); do **not** start TTS. If no `sourceDoc` (direct/legacy authoring), skip to step 4 using the current `ProjectDoc`+`cues`.
**2. TTS** — synthesize each `ScriptSegment` via the cloned voice (`meta.anchors[*].voiceId`). Returns per-segment audio + word/phoneme timing → `BeatTiming.speakDuration`. (`VITE_API_URL` must point at the deployed Worker so cloned voices resolve — CLAUDE.md gotcha.)
**3. Build context** — resolves sticky state (§7.1.2), freezes `ctx.timing`. From here everything is a pure function of `ctx`.
**4. Compile** — final `{project, cues, look}` (and `compileToEngineThree(ctx)` for premium master).
**5. applyProject** — fans out: `avatarUrl`, `emotion`, `shot`, `studioOn`, `idleMotion`, `headline`, `lights`, `backScreen`, `graphics`. Idempotent.
**6. Preload** — decode all `AudioCue.src`, graphic images, body clips up front. **No network/IO during perform.**
**7. Perform (SP-1 + SP-2)** — frame-exact renderer (§8.1): Worker + OffscreenCanvas; clock = `t=i/fps`. Per frame: advance all cues to `frameTime(i)`, render the Three.js scene, run the SP-2 `EffectComposer`, capture `VideoFrame`, feed `VideoEncoder` (`avc1` default, `hvc1` if `isConfigSupported`). Audio: full mix → one `AudioBuffer` → Mediabunny `AudioBufferSource`. Mux → MP4 (WebM fallback). Resolution/aspect = `meta` capture format (§4.15).
**8. Deliver** — Client (default): download the MP4. Premium (opt-in): POST frames (or the backend-B `EngineRenderSpec`+`manifest`) to `services/gpu/finishing` (GFPGAN→Real-ESRGAN×4→RIFE→libx264 CRF16+AAC; parameterize the hardcoded 1080 target; **no NVENC** on H100).

#### 7.6.1 Re-compile vs cached

If `sourceDoc` present, Record **always re-compiles** (TTS timing ≠ import-time WPM estimate). If only a `ProjectDoc` exists, Record uses the stored `cues` as-is.

#### 7.6.2 Preview vs Record

| | Preview (scrub/play) | Record |
|---|---|---|
| Clock | `rAF` (real-time) | frame index `i/fps` (offline) |
| Timing | WPM estimate (no TTS) | real TTS timing |
| Audio | Web Speech (may be silent) | rendered `AudioBuffer` (always audible) |
| Output | on-screen | MP4 / master |

Preview is approximate; **Record is the deterministic authority.**

### 7.7 Error handling & validation

| Layer | When | Mechanism | Surface |
|---|---|---|---|
| Schema | import + Record step 1 | `validateNewsReport` (zod) | inline editor error panel with field paths |
| Reference integrity | post-schema | resolver checks (anchorId exists, voiceId set, graphic `src` reachable) | warning list (non-fatal where possible) |
| Capability | applyProject/perform | avatarController GAP no-ops | console warning, never throws |
| Codec | perform step 7 | `VideoEncoder.isConfigSupported` | downgrade `hvc1`→`avc1`→WebM with toast |

**Surfacing zod errors:** each `ZodError` issue → `{path: i.path.join('.'), message, ncastLine?}`; the editor shows a non-blocking panel and aborts import. Enum violations produce the **exact allowed list** (zod `z.enum` native). `.ncast` parse errors carry line/column. Reference-integrity issues are **warnings** allowing a best-effort compile.

**Fail-loud policy (CLAUDE.md):** no retries on TTS/render/Record. A TTS/encoder failure **aborts Record loudly** with the failing stage + cause; it does not silently fall back to a placeholder. The only fallbacks are codec downgrade and capability no-ops (correctness-preserving).

---

## 8. Subsystem designs — SP-1 MP4/4K export + SP-2 camera filters/look

These two subsystems are foundational chores: every render path depends on them, and `NewsReportDoc.look` plus `meta.fps`/`aspect`/capture-format wire directly into them. SP-1 (export) and SP-2 (look) are designed together: SP-2 inserts a post-processing pass after the scene render, and SP-1 reads the *post-processed* framebuffer when it grabs each `VideoFrame`. Order is load-bearing — the composited (graded, bloomed, tone-mapped) pixels are what land in the MP4.

### 8.1 SP-1 — Frame-exact offline MP4/4K export

#### 8.1.1 Problem with the status quo

`apps/avatar-live/src/capture/recorder.ts` uses `MediaRecorder` over `canvas.captureStream()` — fatally non-deterministic: wall-clock driven (frame timing drifts under GC/throttling/slow `EffectComposer`); WebM-only (broadcast needs H.264/H.265 MP4); Web Speech has no captured audio (silent MP4s); no 4K (drops frames). The replacement is a **frame-exact offline renderer**: render decoupled from real time, driven by an integer frame index, encoding through `WebCodecs` into MP4 via the `Mediabunny` muxer, with audio rendered offline to an `AudioBuffer`.

#### 8.1.2 Architecture overview

```
┌─────────────────── main thread ───────────────────┐
│ ExportController (capture/export/ExportController.ts)│
│  • builds RenderPlan from ProjectDoc + Cue[]        │
│  • owns Scene/Camera/Renderer (OffscreenCanvas)     │
│  • owns SP-2 EffectComposer (look)                  │
│  • offline audio render → AudioBuffer (PCM)         │
│  • for i in [0..N): tick(i/fps); composer.render(); │
│       frame = new VideoFrame(canvas, {timestamp})   │
│       postMessage(frame) ─┐  (transferable)         │
└───────────────────────────┼────────────────────────┘
                            ▼
        ┌──────── Web Worker: EncoderWorker ─────────┐
        │ capture/export/encoder.worker.ts            │
        │  • VideoEncoder (avc1 / hvc1)               │
        │  • AudioEncoder  (mp4a.40.2 AAC-LC / opus)  │
        │  • Mediabunny Output + Mp4OutputFormat      │
        │  • backpressure via encodeQueueSize         │
        │  • finalize() → ArrayBuffer (MP4) ──────────┼─► Blob → download / R2
        └─────────────────────────────────────────────┘
```

Render + `VideoFrame` grab stay on the thread that owns the WebGL context; encoding + muxing run in the worker. `VideoFrame` is `Transferable` (zero-copy hand-off). A fully worker-side variant (transfer `OffscreenCanvas`, run three.js + composer in the worker) is the **V2** target once SP-2 is proven headless; MVP keeps render on main, encode in worker.

#### 8.1.3 The deterministic clock

**The render clock is the frame index, never `performance.now()`/`requestAnimationFrame`.**

```ts
export interface DeterministicClock {
  readonly fps: number;          // from NewsReportDoc.meta.fps (default 30)
  readonly totalFrames: number;  // ceil(durationSec * fps)
  timeAt(i: number): number;     // i / fps — the ONLY time source during export
}
```

```ts
for (let i = 0; i < clock.totalFrames; i++) {
  const t = clock.timeAt(i);              // = i / fps, deterministic
  plan.applyAt(t);                        // drive Cue[] → avatarController + camera + lights
  mixer.setTime(t);                       // AnimationMixer absolute time, NOT update(dt)
  lipsync.sampleAt(t);                    // viseme/jawOpen from precomputed phoneme track
  composer.render();                      // SP-2 pipeline → OffscreenCanvas
  const frame = new VideoFrame(canvas, {
    timestamp: Math.round(t * 1_000_000), // microseconds, frame-exact
    duration: Math.round(1_000_000 / fps),
  });
  await pushFrameWithBackpressure(frame); // §8.1.6
}
```

Required upstream changes (the time-addressable avatarController GAPS): `mixer.setTime(t)` (absolute) not `update(dt)`; camera `CameraCue` interp pure `f(t)`; lip-sync = a **precomputed phoneme/viseme track** so `lipsync.sampleAt(t)` is a pure lookup (face channels `jawOpen,mouthWide,mouthRound,mouthClose,smile,frown,browRaise,blink`; `blink` seeded from a deterministic PRNG keyed on frame index); emotion cross-fade, head tilt/nod, gaze, static-pose all expose `evaluateAt(t)`. Guarantees a **bit-reproducible** render given the same `NewsReportDoc` + voice audio + `look`.

#### 8.1.4 Offline audio mix → AudioBuffer

Audio is rendered **offline** (no real-time playback), fixing the Web-Speech-silent bug and guaranteeing A/V sync, via `OfflineAudioContext` (48 kHz, stereo): narration `AudioBufferSourceNode`s per beat at `start`; `AudioCue` tracks (`bed|sfx|natpop|sot`) with `volume`/`fadeIn`/`fadeOut` via `GainNode` linear ramps; ducking (V2) automates a bed `GainNode` down during narration windows. `ctx.startRendering()` → `AudioBuffer` → planar PCM → `AudioEncoder` (AAC-LC). Both video timestamps and the audio buffer derive from the same `meta.fps`-locked timeline, so **drift is structurally impossible**.

> **Hard rule for MVP export:** Web Speech is a *preview* TTS only. Recorded MP4s use cloned-voice `ServerTts` (or a decodable buffer). The export UI warns-and-blocks if the project is on the Web Speech path. This resolves the "Web-Speech no-audio" defect by construction.

#### 8.1.5 Codec & resolution selection

Resolutions (`CaptureFormat`, §4.15): `720p`=1280×720, `1080p`=1920×1080, `1440p`=2560×1440, `4K UHD 3840x2160`=3840×2160, `vertical 1080x1920`=1080×1920, `square 1080`=1080×1080. Codec selection is **probe-first** via `VideoEncoder.isConfigSupported`:
- **`avc1` (H.264) default** — universally supported.
- **`hvc1` (H.265) opt-in, feature-gated** (`hvc1.1.6.L120.B0`); Safari/some Chrome with hardware HEVC only — else silently fall back to H.264.
- Audio `mp4a.40.2` (AAC-LC) in MP4; fall back to `opus` in MP4, last resort WebM.

**Feature-detect ladder:** (1) WebCodecs+OffscreenCanvas+Mediabunny MP4 → frame-exact MP4; (2) WebCodecs present, HEVC unsupported → H.264 MP4; (3) WebCodecs absent → WebM fallback via deterministic `MediaRecorder` + manual `requestFrame()` per tick (marked degraded); (4) OffscreenCanvas absent → hidden on-screen canvas.

**Bitrate targets (VBR hints):**

| Format | Resolution | H.264 | H.265 |
|---|---|---|---|
| 720p | 1280×720 | 8 Mbps | 5 Mbps |
| 1080p | 1920×1080 | 16 Mbps | 10 Mbps |
| 1440p | 2560×1440 | 28 Mbps | 18 Mbps |
| 4K UHD | 3840×2160 | 50 Mbps | 32 Mbps |
| vertical | 1080×1920 | 16 Mbps | 10 Mbps |
| square | 1080×1080 | 12 Mbps | 8 Mbps |

Encoder: `latencyMode:'quality'`, `hardwareAcceleration:'prefer-hardware'`, forced keyframe every `2*fps` frames.

#### 8.1.6 Muxing & backpressure (Mediabunny)

Worker holds `Output({format: Mp4OutputFormat, target: BufferTarget})` + `EncodedVideoPacketSource`/`EncodedAudioPacketSource`; `VideoEncoder.output` → `videoSrc.add`. Per frame: `videoEncoder.encode(frame, {keyFrame: i % (fps*2) === 0})` then `frame.close()` (free GPU memory). **Backpressure:** main loop awaits when `encodeQueueSize` exceeds a high-water mark (~8 frames) — never drops frames, only stalls (each 4K frame ~33 MB). Finalize: `flush()` both encoders + `output.finalize()` → MP4 `ArrayBuffer` → Blob → download or R2 (`work/{jobId}/master.mp4`).

#### 8.1.7 Optional Tier-2 server-finishing "premium master"

Opt-in. Browser export produces the deterministic base; the H100 chain produces a beauty master via `services/gpu/finishing`: `GFPGAN → Real-ESRGAN x4 → RIFE → libx264 CRF 16 + AAC`. Two mandatory fixes: **(1) parameterize the finishing resolution** (currently hardcodes **1080**; add `target_resolution:{w,h}` so a 4K base isn't downscaled); **(2) no NVENC on H100** — use `libx264` (CPU), CRF 16, not `h264_nvenc`. Control flow: browser uploads base + manifest to R2; `control-api` enqueues a finishing job; pod writes `premium_master.mp4` back to R2.

#### 8.1.8 Module layout + public API

```
apps/avatar-live/src/capture/
  recorder.ts                 # DEPRECATED — kept only for WebM fallback (step 3)
  export/
    ExportController.ts       # public entry: exportMovie(plan, opts) → ExportResult
    clock.ts                  # DeterministicClock
    formats.ts                # CaptureFormat, RESOLUTIONS, targetBitrate
    codecPick.ts             # pickVideoCodec/pickAudioCodec + isConfigSupported probes
    audioMix.ts              # renderAudioMix → AudioBuffer (OfflineAudioContext)
    renderPlan.ts            # ProjectDoc + Cue[] → RenderPlan (time-addressable)
    encoder.worker.ts        # VideoEncoder + AudioEncoder + Mediabunny mux
    webmFallback.ts          # MediaRecorder captureStream(0) deterministic fallback
    types.ts                 # ExportOptions, ExportResult, ExportProgress
```

```ts
export interface ExportOptions {
  format: CaptureFormat; fps: number;        // from NewsReportDoc.meta.fps
  codec?: 'auto' | 'h264' | 'h265';          // default 'auto'
  audioCodec?: 'aac' | 'opus';
  tier2?: { enabled: boolean; targetResolution?: { w: number; h: number } };
  onProgress?: (p: ExportProgress) => void;  // { frame, totalFrames, phase }
  destination: 'download' | 'r2';
}
export interface ExportResult { blob?: Blob; r2Key?: string; container: 'mp4'|'webm'; codec: string; degraded: boolean; warnings: string[]; }
export async function exportMovie(plan: RenderPlan, opts: ExportOptions): Promise<ExportResult>;
```

The Record button (`apps/avatar-live/src/app/recording.ts`) is rewired to compile `NewsReportDoc → ProjectDoc + Cue[]` → `renderPlan.ts` → `exportMovie(...)`, falling back to `recorder.ts`/`webmFallback.ts` only when the ladder demands it. Realtime preview keeps `rAF` (preview ≠ export).

### 8.2 SP-2 — Camera filters / look (post-processing)

#### 8.2.1 Goal

A single `look` knob — `NewsReportDoc.look` (`PostProcessingSpec`, §2.11) — plus `Section.lookOverride`/`Beat.lookOverride`, driving a broadcast-grade post chain. Sticky carry-forward applies (§5.5). Implemented with pmndrs `postprocessing` `EffectComposer`, run after `outputRenderer.render()` — it consumes the rendered scene and produces the final framebuffer SP-1 grabs as a `VideoFrame`.

#### 8.2.2 `PostProcessingSpec` in `packages/protocol`

The canonical schema is [§2.11](#211-postprocessingspec-the-look). Added to `scene.ts` and embedded into `SceneDocument` and `EngineRenderSpec` (`jobs.ts`) so the GPU renderer gets the same look. Regenerate JSON Schema (`npm run protocol:schema`). A `resolveLook(doc, sectionId, beatId)` helper applies sticky carry-forward (beat override → section override → doc look → built-in preset). `preset` seeds defaults; `effects` overrides preset fields (shallow merge).

#### 8.2.3 Exact pipeline order

The cardinal rule: **HDR effects before tone-mapping, LDR effects after.** Renderer set to `THREE.NoToneMapping` — the library tone-maps inside the chain (do NOT double-tonemap).

```
scene render → [HalfFloat HDR render target]
  → AO            (HDR, optional)
  → DoF           (HDR, optional)   // dof.focusDistance / bokehScale
  → MotionBlur    (HDR, optional, Later)
  → Bloom         (HDR)             // bloom.intensity/threshold/radius
  ───────────────── ToneMapping (operator+exposure) ───── gamut boundary
  → LUT           (LDR)             // lut.url/intensity (3D .cube → LUT3DEffect)
  → ColorGrade    (LDR)            // grade.contrast/saturation/temperature/tint/exposure
  → ChromaticAberration (LDR)      // chromaticAberration.offset
  → Vignette      (LDR)            // vignette.darkness/offset
  → Grain         (LDR)            // grain.intensity (seeded NoiseEffect)
  → Sharpen       (LDR)            // sharpen.amount (custom Effect / CAS)
  → SMAA          (LAST)           // aa: 'smaa' default; 'msaa' = MSAA RT; 'none'
```

pmndrs merges screen-space effects into a single `EffectPass` (fewer draws), but passes needing their own RT — AO, DoF, Bloom, SMAA — are separate. Tone-mapping is a `ToneMappingEffect` at the start of the LDR `EffectPass`. `EffectComposer` created with `{frameBufferType: HalfFloatType}`.

> **three.js pinned 0.152.2 — ACES now, AgX later.** `ToneMappingMode.ACES_FILMIC` works on r152. **AgX** (`neutral-agx` / `operator:'agx'`) requires **r160+**; on r152 `mapOperator` falls back to ACES with a console warning until the planned r160 bump. Do not ship AgX as a default while pinned.

#### 8.2.4 Built-in presets

`preset` resolves to a baseline `effects` (then merged with explicit `effects`). The **default look is `broadcast`** exactly as §2.11: subtle bloom `(0.3, thr 0.85)` → ACES `exp 1.05` → neutral LUT → gentle grade → subtle vignette → low grain `(0.04)` → mild sharpen → SMAA. `none`=RenderPass+SMAA only; `cinematic`=stronger bloom + DoF + heavier grade; `warm`/`cool`=temperature ±; `noir`=desat high-contrast; `neutral-agx`=AgX (ACES fallback until r160).

#### 8.2.5 UI — Look picker (avatar-live)

A "Look" control group beside the Lighting presets: **Preset dropdown** (7 presets; `neutral-agx` shows a "needs r160 — using ACES" badge); **effect toggles + sliders** (bloom, exposure, vignette, grain, sharpen, LUT upload `.cube`, AA) patching `look.effects` (shallow-merge). Live preview reuses the same `buildComposer` — **WYSIWYG holds**: avatar-live preview, SP-1 export, and engine-three GPU render all call `buildComposer(spec)` with the *same* resolved spec.

#### 8.2.6 engine-three headless-gl validation gate

**Blocking gate before wiring SP-2 into the GPU renderer.** The pod runs headless `gl` + Xvfb; float RTs + multi-pass composites are where headless WebGL diverges. Steps: (1) `EXT_color_buffer_float`/`OES_texture_half_float` present (else fall back to `UnsignedByteType` LDR composer + log); (2) float-RT `EffectComposer` round-trip — render an HDR test scene, read pixels, assert tone-mapped output within tolerance of a browser reference (catches "headless gl writes black/clamps HDR"); (3) per-effect smoke test at 1080p and 4K; (4) wire into `services/engine-three/src/look/` and expose `/engine-three/health` flags `postFx:true`, `floatRT:true` alongside `wysiwygScene`/`leePerrySmithLoaded`. Until this passes, engine-three renders with `preset:'none'`.

#### 8.2.7 Performance budget

| Stage | 1080p | 4K | Notes |
|---|---|---|---|
| HalfFloat RT (HDR) | +0.3 ms | +1.2 ms | doubles RT bandwidth |
| Bloom (mip chain) | ~0.6 ms | ~2.5 ms | dominant HDR cost |
| ToneMapping+grade+CA+vignette+grain+sharpen (merged) | ~0.5 ms | ~2.0 ms | single fullscreen pass |
| LUT3D | ~0.2 ms | ~0.8 ms | 3D texture sample |
| SMAA | ~0.4 ms | ~1.6 ms | 3-pass |
| AO (optional) | ~1.0 ms | ~4 ms | off by default in broadcast |
| DoF (optional) | ~1.2 ms | ~5 ms | cinematic preset only |
| **broadcast total (no AO/DoF)** | **~2.2 ms** | **~8.5 ms** | comfortably real-time at 1080p |

Rules: 1080p preview holds 60 fps (post ≤ 4 ms); 4K preview may drop below 60 fps (acceptable — preview may render every other frame; **export unaffected**, offline); 4K export throughput target ≥ 5 rendered+encoded fps; AO/DoF opt-in (not in `broadcast`); `EffectPass` merging mandatory (one merged LDR pass + separate Bloom/SMAA/AO/DoF).

**Cross-subsystem contract:** SP-2's `composer.render()` is the exact call SP-1's export loop invokes per frame (§8.1.3); the post-processed `OffscreenCanvas` is the source of every `VideoFrame`. `PostProcessingSpec` lives in `packages/protocol` and flows to all three render surfaces via `look`/`lookOverride` with sticky carry-forward, keeping browser preview, browser export, and GPU render pixel-consistent.

---

## 9. Worked examples + testing + build order

This section is the conformance anchor. Every JSON object below validates against the §2 zod types; every `.ncast` block parses under the §3 grammar; every enum value is drawn verbatim from §4. If a future change makes an example fail `zod.parse`, the example is the bug — fix the doc, not the type.

### 9.1 Full worked newscast — `NewsReportDoc` (canonical JSON)

A complete 4-section rundown: **cold-open bumper → VO story (lower-third + back-screen) → PKG story (3-shot camera move + music bed with ducking + dissolve out) → KICKER sign-off**. Single anchor, 1080p @ 30fps, `broadcast` look at the doc level with per-section/per-beat overrides. *(Conforms to §2: `Emphasis {text, level}`, `sayAs {text, as}`, `BrandKit.palette {primary, secondary, …}`, `logo.corner: tr`, `CaptionsSpec {enabled, mode, standard, cleanFeed}`.)*

```jsonc
{
  "version": 2,
  "meta": {
    "title": "Evening Edition — Cold Open to Kicker",
    "anchors": [
      { "id": "anchor_main", "name": "Ava Lin", "avatarUrl": "/avatars/ava.glb", "voiceId": "voice_ava_clone" }
    ],
    "language": "en-US",
    "fps": 30,
    "aspect": "16:9",
    "captions": { "enabled": true, "mode": "sidecar", "standard": "608", "cleanFeed": true }
  },

  "brandKit": {
    "palette": { "primary": "#0B5FFF", "secondary": "#06133A", "accent": "#FFC400", "textOnDark": "#FFFFFF", "textOnLight": "#101418" },
    "fonts": { "display": "Saira Condensed", "body": "Inter" },
    "logo": { "src": "/brand/logo.png", "corner": "tr", "opacity": 1 },
    "lowerThirdStyle": "bar",
    "safeAreas": { "title": 0.1, "action": 0.05 },
    "musicBed": { "id": "show_bed", "kind": "bed", "src": "/audio/news_theme_loop.mp3", "volume": 0.35 }
  },

  "look": {
    "preset": "broadcast",
    "effects": {
      "toneMapping": { "operator": "aces", "exposure": 1.05 },
      "bloom": { "intensity": 0.3, "threshold": 0.85, "radius": 0.4 },
      "lut": { "url": "https://cdn.example.com/luts/neutral.cube", "intensity": 1.0 },
      "grade": { "contrast": 1.02, "saturation": 1.04, "temperature": 0.0, "tint": 0.0, "exposure": 0.0 },
      "vignette": { "darkness": 0.25, "offset": 0.5 },
      "grain": { "intensity": 0.04 },
      "sharpen": { "amount": 0.2 },
      "aa": "smaa"
    }
  },

  "defaults": {
    "emotion": "confident",
    "gesture": "none",
    "posture": "upright",
    "gaze": "camera",
    "pause_ms_after": 220,
    "camera": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.5 }
  },

  "rundown": [
    {
      "id": "sec_coldopen",
      "slug": "COLD OPEN",
      "storyForm": "KICKER",
      "block": "A",
      "set": { "mode": "virtual", "backScreen": { "kind": "image", "src": "/sets/title_card.png" } },
      "cameraDefault": { "shot": "wide", "move": "dolly_in", "target": "full_body", "easing": "ease_out", "intensity": 0.4 },
      "graphics": [
        { "id": "gfx_bumper", "kind": "bumper", "at": 0.0, "out": 3.2, "anim": "fade", "src": "https://cdn.example.com/brand/cold_open_bumper.mp4" }
      ],
      "audio": [
        { "id": "aud_sting", "kind": "sfx", "src": "/audio/open_sting.mp3", "start": 0.0, "duration": 3.2, "volume": 0.9, "fadeIn": 0.0, "fadeOut": 0.6 }
      ],
      "beats": [
        {
          "id": "b_open_1",
          "text": "Tonight: the city's budget vote, a breakthrough in the harbor cleanup, and the weather that has everyone talking.",
          "emotion": "excited",
          "gesture": "open_palms",
          "posture": "upright",
          "emphasis": [{ "text": "everyone talking", "level": "strong" }],
          "pause_ms_after": 400,
          "camera": { "shot": "wide", "move": "dolly_in", "target": "full_body", "easing": "ease_out", "intensity": 0.5 },
          "gaze": "camera"
        }
      ]
    },

    {
      "id": "sec_budget",
      "slug": "BUDGET VOTE",
      "storyForm": "VO",
      "block": "A",
      "adBreakAfter": false,
      "softTime": 35,
      "anchorId": "anchor_main",
      "set": { "mode": "virtual", "backScreen": { "kind": "image", "src": "/backscreens/city_hall.jpg" } },
      "cameraDefault": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.5 },
      "graphics": [
        { "id": "lt_budget", "kind": "lowerThird", "at": 1.0, "out": 6.5, "anim": "slideUp", "title": "CITY BUDGET PASSES", "subtitle": "Council approves $4.2B spending plan" }
      ],
      "beats": [
        {
          "id": "b_budget_1",
          "text": "The city council approved a four-point-two billion dollar budget late last night.",
          "emotion": "serious",
          "gesture": "none",
          "posture": "upright",
          "emphasis": [{ "text": "four-point-two billion", "level": "moderate" }],
          "sayAs": [{ "text": "$4.2B", "as": "currency" }],
          "pause_ms_after": 250,
          "camera": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.3 },
          "gaze": "camera"
        },
        {
          "id": "b_budget_2",
          "text": "Most of the new money goes to transit and the harbor cleanup we'll cover next.",
          "emotion": "confident",
          "gesture": "point",
          "posture": "leaning_in",
          "pause_ms_after": 300,
          "camera": { "shot": "medium_close", "move": "dolly_in", "target": "face", "easing": "ease_in", "intensity": 0.4 },
          "transition": { "type": "dissolve", "dur": 0.5 },
          "gaze": "monitor"
        }
      ]
    },

    {
      "id": "sec_harbor",
      "slug": "HARBOR CLEANUP",
      "storyForm": "PKG",
      "block": "B",
      "adBreakAfter": true,
      "hardTime": 90,
      "anchorId": "anchor_main",
      "set": { "mode": "virtual", "backScreen": { "kind": "video", "src": "/broll/harbor_drone.mp4" } },
      "cameraDefault": { "shot": "full", "move": "static", "target": "torso", "easing": "ease_in_out", "intensity": 0.5 },
      "lookOverride": {
        "preset": "cinematic",
        "effects": {
          "toneMapping": { "operator": "aces", "exposure": 1.0 },
          "bloom": { "intensity": 0.45, "threshold": 0.8, "radius": 0.5 },
          "grade": { "contrast": 1.06, "saturation": 0.98, "temperature": -0.04, "tint": 0.0, "exposure": 0.0 },
          "vignette": { "darkness": 0.35, "offset": 0.45 },
          "grain": { "intensity": 0.06 },
          "dof": { "focusDistance": 3.2, "bokehScale": 1.5 },
          "aa": "smaa"
        }
      },
      "audio": [
        { "id": "bed_pkg", "kind": "bed", "src": "/audio/hopeful_underscore.mp3", "start": 0.0, "duration": 14.0, "volume": 0.6, "fadeIn": 1.0, "fadeOut": 1.5, "duck": { "target": "voice", "amount": 0.65 } }
      ],
      "beats": [
        {
          "id": "b_harbor_1",
          "text": "For a decade the harbor was a dead zone. This year, the fish came back.",
          "emotion": "warm",
          "gesture": "open_palms",
          "posture": "relaxed",
          "pause_ms_after": 350,
          "camera": { "shot": "wide", "move": "truck_left", "target": "full_body", "easing": "ease_out", "intensity": 0.6 },
          "gaze": "camera"
        },
        {
          "id": "b_harbor_2",
          "text": "Crews removed sixty tons of debris and rebuilt the oyster reefs by hand.",
          "emotion": "confident",
          "gesture": "count",
          "posture": "upright",
          "emphasis": [{ "text": "sixty tons", "level": "strong" }],
          "pause_ms_after": 300,
          "camera": { "shot": "medium", "move": "dolly_in", "target": "chest", "easing": "ease_in_out", "intensity": 0.5 },
          "gaze": "camera"
        },
        {
          "id": "b_harbor_3",
          "text": "Scientists say the bay could be swimmable again within two years.",
          "emotion": "happy",
          "gesture": "nod",
          "posture": "leaning_in",
          "pause_ms_after": 450,
          "camera": { "shot": "close_up", "move": "static", "target": "eyes", "easing": "ease_in", "intensity": 0.4 },
          "transition": { "type": "dissolve", "dur": 0.6 },
          "gaze": "camera"
        }
      ]
    },

    {
      "id": "sec_kicker",
      "slug": "KICKER / SIGN-OFF",
      "storyForm": "KICKER",
      "block": "B",
      "set": { "mode": "virtual", "backScreen": { "kind": "image", "src": "/sets/skyline_dusk.png" } },
      "cameraDefault": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.5 },
      "lookOverride": {
        "preset": "warm",
        "effects": {
          "toneMapping": { "operator": "aces", "exposure": 1.08 },
          "grade": { "contrast": 1.0, "saturation": 1.06, "temperature": 0.08, "tint": 0.02, "exposure": 0.0 },
          "vignette": { "darkness": 0.2, "offset": 0.5 },
          "grain": { "intensity": 0.03 },
          "aa": "smaa"
        }
      },
      "beats": [
        {
          "id": "b_kicker_1",
          "text": "And finally — the weather everyone's been waiting for.",
          "emotion": "happy",
          "gesture": "explain",
          "posture": "relaxed",
          "pause_ms_after": 300,
          "camera": { "shot": "medium", "move": "static", "target": "face", "easing": "ease_in_out", "intensity": 0.3 },
          "gaze": "camera"
        },
        {
          "id": "b_kicker_2",
          "text": "Clear skies all weekend. From all of us here, goodnight.",
          "emotion": "warm",
          "gesture": "wave",
          "posture": "upright",
          "emphasis": [{ "text": "goodnight", "level": "moderate" }],
          "pause_ms_after": 600,
          "camera": { "shot": "wide", "move": "dolly_out", "target": "full_body", "easing": "ease_out", "intensity": 0.7 },
          "transition": { "type": "fade", "dur": 1.0 },
          "gaze": "camera"
        }
      ]
    }
  ]
}
```

### 9.2 The same newscast — `.ncast` screenplay

Identical performance in the directive-keyword `.ncast` style (§3). The parser produces a `NewsReportDoc` byte-equivalent (after default-fill) to §9.1; that equivalence is the round-trip test in §9.4.

```ncast
:: TITLE  Evening Edition — Cold Open to Kicker
:: ANCHOR anchor_main  "Ava Lin"  avatar=/avatars/ava.glb  voice=voice_ava_clone
:: LANG   en-US
:: FPS    30
:: ASPECT 16:9
:: CAPTIONS enabled mode=sidecar standard=608 cleanFeed=true

@brand
  palette  primary=#0B5FFF secondary=#06133A accent=#FFC400 textOnDark=#FFFFFF textOnLight=#101418
  fonts    display="Saira Condensed" body="Inter"
  logo     /brand/logo.png  corner=tr
  lowerThirdStyle  bar
  safeAreas   title=0.1 action=0.05
  music    /audio/news_theme_loop.mp3  vol=0.35

@look broadcast
  tone     aces exp=1.05
  bloom    0.3 thr=0.85 radius=0.4
  lut      https://cdn.example.com/luts/neutral.cube  intensity=1.0
  grade    contrast=1.02 saturation=1.04
  vignette 0.25 offset=0.5
  grain    0.04
  sharpen  0.2
  aa       smaa

@defaults
  emotion confident  gesture none  posture upright  gaze camera  pause 220
  camera  medium static face ease_in_out 0.5

= = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

## COLD OPEN  [KICKER]  block=A
SET virtual  backScreen=image:/sets/title_card.png
CAM wide dolly_in full_body ease_out 0.4
GFX bumper https://cdn.example.com/brand/cold_open_bumper.mp4  at=0.0 out=3.2 anim=fade
AUD sfx /audio/open_sting.mp3  start=0.0 dur=3.2 vol=0.9 fadeOut=0.6

  (excited, open_palms, upright)  CAM wide dolly_in full_body ease_out 0.5
  Tonight: the city's budget vote, a breakthrough in the harbor
  cleanup, and the weather that has **everyone talking**.
  | pause 400

= = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

## BUDGET VOTE  [VO]  block=A  soft=35  anchor=anchor_main
SET virtual  backScreen=image:/backscreens/city_hall.jpg
CAM medium static face ease_in_out 0.5
LT  "CITY BUDGET PASSES" / "Council approves $4.2B spending plan"  at=1.0 out=6.5 anim=slideUp

  (serious, none, upright)  CAM medium static face ease_in_out 0.3
  The city council approved a *four-point-two billion* dollar
  budget late last night.
  ~sayAs currency "$4.2B"
  | pause 250

  (confident, point, leaning_in)  gaze=monitor
  CAM medium_close dolly_in face ease_in 0.4
  Most of the new money goes to transit and the harbor cleanup
  we'll cover next.
  >> dissolve 0.5
  | pause 300

= = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

## HARBOR CLEANUP  [PKG]  block=B  hard=90  adBreakAfter  anchor=anchor_main
SET virtual  backScreen=video:/broll/harbor_drone.mp4
CAM full static torso ease_in_out 0.5
LOOK cinematic
  tone aces exp=1.0 ; bloom 0.45 thr=0.8 radius=0.5
  grade contrast=1.06 saturation=0.98 temperature=-0.04
  vignette 0.35 offset=0.45 ; grain 0.06 ; dof focus=3.2 bokeh=1.5 ; aa smaa
BED /audio/hopeful_underscore.mp3  start=0.0 dur=14.0 vol=0.6 fadeIn=1.0 fadeOut=1.5 duck=voice:0.65

  (warm, open_palms, relaxed)  CAM wide truck_left full_body ease_out 0.6
  For a decade the harbor was a dead zone. This year, the fish came back.
  | pause 350

  (confident, count, upright)  CAM medium dolly_in chest ease_in_out 0.5
  Crews removed **sixty tons** of debris and rebuilt the oyster reefs by hand.
  | pause 300

  (happy, nod, leaning_in)  CAM close_up static eyes ease_in 0.4
  Scientists say the bay could be swimmable again within two years.
  >> dissolve 0.6
  | pause 450

= = = = = = = = = = = = = = = = = = = = = = = = = = = = = =

## KICKER / SIGN-OFF  [KICKER]  block=B
SET virtual  backScreen=image:/sets/skyline_dusk.png
CAM medium static face ease_in_out 0.5
LOOK warm
  tone aces exp=1.08 ; grade saturation=1.06 temperature=0.08 tint=0.02
  vignette 0.2 offset=0.5 ; grain 0.03 ; aa smaa

  (happy, explain, relaxed)  CAM medium static face ease_in_out 0.3
  And finally — the weather everyone's been waiting for.
  | pause 300

  (warm, wave, upright)  CAM wide dolly_out full_body ease_out 0.7
  Clear skies all weekend. From all of us here, *goodnight*.
  >> fade 1.0
  | pause 600
```

**Grammar legend** (per §3): `::` document meta directives; `@brand`/`@look`/`@defaults` config blocks; `## SLUG [storyForm] key=val` section headers; `SET`/`CAM`/`LOOK` section directives; `LT`/`GFX`/`AUD`/`BED` graphics & audio directives; `(emotion, gesture, posture)` beat header with inline `key=val` overrides (`gaze=`); `CAM …` beat-level camera; `*phrase*` = `moderate` emphasis, `**phrase**` = `strong` (canonical §2.8 levels); `~sayAs as "text"` SSML say-as (`{text, as}`); `>> type dur` transition; `| pause ms` trailing pause. The parser fills omitted fields from `@defaults` → section default → §2 type default. *(Conforms to §2: emphasis levels `moderate`/`strong`, `sayAs` as `{text, as}` with `as=currency`, palette `primary`+`secondary`, `logo corner=tr`, `CAPTIONS standard=608`.)*

### 9.3 Six focused mini-snippets

Each validates in isolation (graphics/audio against their parent `Section`, beats against `Beat`).

**(a) Lower-third** — `Graphic{kind:'lowerThird'}` (§2.9):

```jsonc
{ "id": "lt_1", "kind": "lowerThird", "at": 1.0, "out": 6.0, "anim": "slideUp",
  "title": "DR. PRIYA NAIR", "subtitle": "Marine Biologist, Harbor Trust" }
```
`.ncast`: `LT "DR. PRIYA NAIR" / "Marine Biologist, Harbor Trust"  at=1.0 out=6.0 anim=slideUp`

**(b) 3-shot camera sequence with easing** — three beats, each with `camera: CameraCue`. Sticky carry-forward means an unspecified field inherits the previous beat:

```jsonc
[
  { "id": "c1", "text": "We start wide on the newsroom.", "emotion": "neutral", "gesture": "none", "posture": "upright",
    "pause_ms_after": 200, "camera": { "shot": "wide", "move": "static", "target": "full_body", "easing": "ease_out", "intensity": 0.3 } },
  { "id": "c2", "text": "Push in as the story sharpens.", "emotion": "serious", "gesture": "none", "posture": "leaning_in",
    "pause_ms_after": 200, "camera": { "shot": "medium", "move": "dolly_in", "target": "face", "easing": "ease_in_out", "intensity": 0.5 } },
  { "id": "c3", "text": "And land tight on the key fact.", "emotion": "confident", "gesture": "point", "posture": "leaning_in",
    "pause_ms_after": 300, "camera": { "shot": "close_up", "move": "dolly_in", "target": "eyes", "easing": "ease_in", "intensity": 0.7 } }
]
```

**(c) Music bed + duck under VO** — section-level `AudioCue{kind:'bed'}` with `duck` (§2.10):

```jsonc
{ "id": "bed_1", "kind": "bed", "src": "/audio/underscore.mp3", "start": 0.0, "duration": 12.0,
  "volume": 0.6, "fadeIn": 1.0, "fadeOut": 1.5, "duck": { "target": "voice", "amount": 0.6 } }
```
`.ncast`: `BED /audio/underscore.mp3  start=0.0 dur=12.0 vol=0.6 fadeIn=1.0 fadeOut=1.5 duck=voice:0.6`
Compiler note: output bed gain = `volume * (1 - amount)` whenever a narration beat is active, ramped 120 ms attack / 250 ms release (§7.2.7).

**(d) Per-beat look override** — `Beat.lookOverride` is a partial `PostProcessingSpec`; it merges over the active section/doc look for that beat's span only, then reverts (scoped — §5.5.2):

```jsonc
{ "id": "shock_beat", "text": "Then — everything changed.", "emotion": "surprised", "gesture": "open_palms",
  "posture": "upright", "pause_ms_after": 500,
  "camera": { "shot": "extreme_close_up", "move": "static", "target": "eyes", "easing": "ease_in", "intensity": 0.2 },
  "lookOverride": {
    "preset": "noir",
    "effects": {
      "grade": { "contrast": 1.2, "saturation": 0.0, "temperature": 0.0, "tint": 0.0, "exposure": -0.1 },
      "vignette": { "darkness": 0.6, "offset": 0.3 },
      "grain": { "intensity": 0.12 }
    }
  } }
```

**(e) Dissolve transition** — `Beat.transition` runs at the *end* of the beat, crossing into whatever renders next:

```jsonc
{ "id": "t1", "text": "More on that after the break.", "emotion": "confident", "gesture": "none", "posture": "upright",
  "pause_ms_after": 250, "transition": { "type": "dissolve", "dur": 0.6 } }
```
`.ncast`: trailing `>> dissolve 0.6` line under the beat. Allowed `type` (§4.8): `cut | dissolve | fade | wipe | defocus`. `cut` ignores `dur`.

**(f) Chroma / AR set with back-screen** — `Section.set` with `mode` and a `backScreen` (§2.7.1):

```jsonc
{ "id": "sec_ar", "slug": "MARKETS", "storyForm": "READER",
  "set": { "mode": "chroma", "backScreen": { "kind": "video", "src": "/backscreens/markets_wall.mp4" } },
  "cameraDefault": { "shot": "medium", "move": "truck_right", "target": "torso", "easing": "ease_in_out", "intensity": 0.4 },
  "beats": [
    { "id": "ar1", "text": "Markets closed higher across the board.", "emotion": "confident", "gesture": "explain",
      "posture": "upright", "pause_ms_after": 250, "gaze": "monitor" }
  ] }
```
`.ncast`:
```ncast
## MARKETS  [READER]
SET chroma  backScreen=video:/backscreens/markets_wall.mp4
CAM medium truck_right torso ease_in_out 0.4
  (confident, explain, upright)  gaze=monitor
  Markets closed higher across the board. | pause 250
```
An `AR` set is the same shape with `mode:'AR'`; `mode ∈ real | chroma | virtual | LED | AR` (§4.9). `backScreen.kind ∈ none|color|image|video|stream|chart` (§2.7.1).

### 9.4 Testing strategy

Four layers, all runnable under `npm test` (protocol vitest) with no GPU and no network. CI-free per project convention; every layer is a fast deterministic local check.

**Layer 1 — zod schema validation (structural).**
- `NewsReportDoc.parse()` on every fixture in §9.1 and §9.3 must succeed; assert no `safeParse().error`.
- Negative fixtures: unknown enum (`emotion:"angry"`), `version:1`, `transition.type:"swipe"`, `Graphic.kind:"banner"`, `set.mode:"hologram"`, `audio.kind:"voiceover"` — each `safeParse().success === false` with the error path at the offending field. Pins the §4 vocabularies.
- After every protocol edit and `npm run protocol:schema`: re-validate the regenerated JSON Schema against the same fixtures with `ajv` so the TS zod source and exported JSON Schema can never drift.

**Layer 2 — golden-file lowering tests (semantic, deterministic).**
The compiler (`compileNewsReport`) lowers `NewsReportDoc → { project: ProjectDoc, cues: Cue[] }` and `→ EngineRenderSpec/PerformanceManifest`. For each worked example:
- Lower with a **fixed mock TTS-timing table** (deterministic per-beat durations keyed by `beat.id`, e.g. `text.length * 60ms`).
- Snapshot the `ProjectDoc`, the full `Cue[]` (sorted by `start`, `track`), and the `PerformanceManifest` to `__golden__/*.json`.
- Assert sticky carry-forward (§5.5/§7.1.2): a beat omitting `camera` inherits the prior resolved cue; a section omitting `look` inherits the doc `look`; a beat `lookOverride` appears for exactly one beat span and the next beat reverts. Verify emitted cue values, not input.
- Assert ducking: every narration beat span overlapping a `bed` cue produces an automated `audio`-track volume node at `volume*(1-amount)`.
- Assert parity (§7.3.4): `compileToAvatarLive` cues and `compileToEngineThree` manifest agree on state-at-time-t.
- Golden files are committed; a diff is a deliberate behavior change.

**Layer 3 — deterministic-render frame-hash (SP-1 correctness).**
- Render §9.1 at 1080p/30 to N frames; hash each `VideoFrame`'s RGBA readback → `frame-hashes.json` golden, plus a hash of the muxed MP4 video track.
- Re-render → hashes must match exactly. Drift means a non-deterministic input leaked (rAF, `Date.now`, `Math.random`, un-seeded grain). Grain/blink seeded per frame-index (§8.1.3).
- Headless engine-three: validate the float-RT `EffectComposer` round-trip in `gl`/Xvfb FIRST (§8.2.6), then frame-hash the same doc; the two backends are not required to be pixel-identical (different renderers) but each must be internally reproducible.
- Audio determinism: hash the exported `AudioBuffer` (the mix incl. ducking) — locks the Web-Speech no-audio fix.

**Layer 4 — `.ncast` parser round-trip.**
- `parseNcast(text).doc → NewsReportDoc`, then `NewsReportDoc.parse()` must succeed.
- **Round-trip equality:** `parseNcast(§9.2).doc` deep-equals `§9.1` after both run through `NewsReportDoc.parse()` (default-fill normalizes both sides).
- **Render round-trip:** `serializeNcast(parseNcast(text).doc)` re-parses to a deep-equal doc (idempotent; lossy only on whitespace/comments, never semantics).
- Fuzz: property-test that any zod-valid `NewsReportDoc` serializes to `.ncast` that re-parses equal (covers fields the worked examples don't exercise: `MOS`, `STANDUP`, `DONUT`, `chart`, `map`, `ticker`, `bug`, every transition type, every set mode).

### 9.5 Build order — SP-1 → SP-2 → SP-3 → SP-4/5, with MVP cut line

Ordered so each step is shippable and the MVP demo is reachable early. SP-1 and SP-2 are the two chartered chores; SP-3+ build the document layer on top.

| Step | Scope | Key deliverables | Tier | Depends on |
|---|---|---|---|---|
| **SP-1** | Frame-exact MP4 / 4K export | Web Worker + OffscreenCanvas + WebCodecs `VideoEncoder` + Mediabunny mux; clock by `t=i/fps`; Web-Audio mix → `AudioBuffer` (fixes Web-Speech no-audio); `avc1` default, `hvc1` gated by `isConfigSupported`, all 6 capture formats, WebM fallback. Optional Tier-2 H100 finishing (parameterize the hardcoded 1080 target; H100 has NO NVENC → libx264). | **MVP** | — |
| **SP-2** | Filters / look | pmndrs `postprocessing` `EffectComposer` after `outputRenderer.render()`; pipeline HDR→tonemap→LDR (AO/DoF/Bloom → ACES ToneMapping → LUT/grade → ChromaticAberration → Vignette → Grain → Sharpen → SMAA); renderer `NoToneMapping`; three.js pinned 0.152.2 (ACES now, AgX later at r160). Add `PostProcessingSpec` to protocol `scene.ts` + `EngineRenderSpec`; regenerate JSON Schema. Validate float-RT composer round-trip in headless `gl`/Xvfb before wiring engine-three. | **MVP** | SP-1 (shared offline render loop) |
| **SP-3** | `NewsReportDoc` v2 in `packages/protocol` + compiler | Add §2 types (`meta/brandKit/look/defaults/Section/Beat/Graphic/AudioCue/transition`) as zod (extends existing `Script`/`CameraCue`/`SceneDocument` additively); `npm run protocol:schema`. `compileNewsReport()` → `ProjectDoc + Cue[]` and → `EngineRenderSpec/PerformanceManifest` with sticky carry-forward for camera/look/set/background. Wire the `projectStore` import discriminator to accept v2 docs. Close the `avatarController` gaps MVP needs (head tilt/nod, emotion cross-fade, static-pose-without-clip, gaze targets, blink force/suppress). | **MVP** (basic rundown: sections + READER/VO, emotion/gesture/camera/pause/lighting/back-screen/headline/music) | SP-1, SP-2 |
| **SP-4** | `.ncast` parser + V2 features | `parseNcast`/`serializeNcast` round-trippable (§9.4 L4); embedded-TS fluent builder. V2 vocab on the wire & compiler: full SSML (`sayAs`/`phoneme`/`prosody`/leveled `emphasis`), transitions (cut/dissolve/fade/wipe/defocus), lower-thirds/ticker/bug, audio ducking, WPM auto-timing, postures wired into avatar-live, gaze targets. | **V2** | SP-3 |
| **SP-5** | Producer-grade rundown | Multi-camera switching, two-shot/OTS multi-avatar, brand kit application, captions 608/708 + dirty/clean, ad-break scheduling (soft/hard/kill/float/pad), B-roll/clip time-manipulation, AR/LED set modes, charts/maps, `neutral-agx`. | **Later** | SP-4 |

**━━━ MVP CUT LINE ━━━** falls **between SP-3 and SP-4**.

Everything **at or above the line (SP-1, SP-2, SP-3)** is the shippable MVP: a `NewsReportDoc` v2 authored as canonical JSON, imported into avatar-live, and Recorded to a frame-exact MP4 with the `broadcast`/`cinematic`/`warm`/etc. look — driving narration + emotion + gesture + camera + pause + lighting + back-screen + headline + music across a basic multi-section rundown (READER/VO). `.ncast` text authoring, full SSML, transitions, lower-thirds/ticker, ducking, WPM auto-timing, wired postures, and gaze are **V2 (SP-4)**; multi-camera, multi-avatar, brand kit, captions, ad-break scheduling, and time-manipulated B-roll are **Later (SP-5)**.

Rationale: SP-1 unblocks *any* real output (no real MP4 / no audio without it), so it is first. SP-2 reuses SP-1's offline render loop and makes output broadcast-credible. SP-3 is the document/compiler spine every authoring surface targets — but worthless without something to render into, hence it follows the two render chores. SP-4 layers richer authoring (`.ncast`) and V2 expressive vocab once the canonical pipeline is proven end-to-end. SP-5 is producer tooling composing established primitives. The §9.4 test layers land incrementally: Layer 1+2 with SP-3, Layer 3 with SP-1/SP-2, Layer 4 with SP-4.

---

*End of spec. Authoritative type contract: §2. Vocabulary status/tier: §4. Compile + runtime: §7. Conformance fixtures: §9.*
