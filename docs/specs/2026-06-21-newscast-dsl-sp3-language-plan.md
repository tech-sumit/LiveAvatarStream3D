# SP-3 — Newscast DSL Language (NewsReportDoc → editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Ship the **language MVP**: a canonical `NewsReportDoc` (v2 JSON) + a pure compiler that lowers it to the editor's `ProjectDoc` + `Cue[]`, plus an import hook so **Import a `.newscast.json` → the whole `apps/avatar-live` editor is configured → Generate → Export MP4** (reusing the merged SP-1 export + SP-2 look).

**Architecture:** The schema (`NewsReportDoc`) and the **pure, three.js-free** compiler (`compileNewsReport`) live in **`packages/protocol`** (the only workspace with a test runner). The compiler reproduces the editor's `ProjectDoc`/`Cue` shapes structurally (it must not import avatar-live) and emits **preset `cam.*` cue types only** — no pose math (runtime `poseFor()` resolves poses against the loaded avatar). `apps/avatar-live`'s `projectStore` gains a discriminator branch: a v2 NewsReportDoc → `compileNewsReport` → existing `applyProject`. No new render/record path — SP-1/SP-2 already deliver.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), zod, vitest (`@las/protocol` only). Reuses `@las/protocol` `dsl.ts` enums (`Emotion`/`Gesture`/`CameraCue`) + `scene.ts` `PostProcessingSpec`. SP-3 of the Newscast DSL build ([design spec](./2026-06-21-newscast-dsl-design.md) §2/§7/§9.5).

**Verification model:** Protocol work → `npm run typecheck --workspace @las/protocol` + `npm test --workspace @las/protocol`. avatar-live wiring → `npm run typecheck`/`build --workspace @las/avatar-live` + a manual studio smoke (Import → Generate → Export). No avatar-live test runner exists — do not invent one. No retries on render/record paths (`CLAUDE.md`).

**Ground-truth corrections (from recon — the CODE is authoritative over the spec prose):**
- `ProjectDoc.look` is `{ preset?: string; params?: LookParams }` where `LookParams` is **flat** (`bloomIntensity, bloomThreshold, contrast, saturation, vignetteOffset, vignetteDarkness, grain`) — NOT the spec's nested `effects.{...}`.
- protocol `PostProcessingSpec` (`scene.ts`) is also flat. The compiler bridges it → `ProjectDoc.look.params` by copying overlapping flat fields.
- `Act`/`StageOp` are **not** in protocol yet → MVP keeps `rundown: Section[]` only (single-act sugar); the `acts`/`StageOp` machinery is deferred (§9.5 V2).

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/protocol/src/newsreport.ts` | **Create** | `NewsReportDoc` zod schema (MVP subset) + `validateNewsReportDoc()`. |
| `packages/protocol/src/newsreportCompile.ts` | **Create** | Pure `compileNewsReport(doc) → { project, cues }` + structural `CompiledProjectDoc`/`CompiledCue`/`LookParams` types + helpers. |
| `packages/protocol/src/index.ts` | Modify | Re-export the two new modules. |
| `packages/protocol/scripts/gen-schema.ts` | Modify | Register `NewsReportDoc` for JSON-Schema emission. |
| `packages/protocol/src/newsreport.test.ts` | **Create** | vitest: schema defaults/rejects + compiler invariants (golden). |
| `apps/avatar-live/src/app/projectStore.ts` | Modify | Import discriminator branch: v2 NewsReportDoc → compile → applyProject. |
| `apps/avatar-live/public/samples/showcase.newscast.json` | **Create** | A real multi-section sample for the E2E smoke. |
| `docs/specs/...sp3...plan.md`, `progress.md` | Modify (this file + log) | Plan + validation log. |

**Shared contract (every task aligns to these names):** `NewsReportDoc`, `Meta`, `Anchor`, `Section`, `Beat`, `AudioCue`, `SectionSet`, `DocDefaults`, `StoryForm`; `compileNewsReport(doc): { project: CompiledProjectDoc; cues: CompiledCue[] }`; `validateNewsReportDoc(data): NewsReportDoc`. Reuse `Emotion`, `Gesture`, `CameraCue` from `./dsl.js` and `PostProcessingSpec` from `./scene.js`.

---

## Task 1: Protocol schema — `newsreport.ts`

**Files:** Create `packages/protocol/src/newsreport.ts`; Modify `packages/protocol/src/index.ts`, `packages/protocol/scripts/gen-schema.ts`.

- [ ] **Step 1: Confirm reused exports**

Run: `grep -nE 'export const (Emotion|Gesture|CameraCue|PostProcessingSpec)\b' packages/protocol/src/dsl.ts packages/protocol/src/scene.ts`
Expected: `Emotion`, `Gesture`, `CameraCue` in `dsl.ts`; `PostProcessingSpec` in `scene.ts`. (If `CameraCue` has all-required fields, that's fine — `Beat.camera` reuses it as a full cue.)

- [ ] **Step 2: Write `packages/protocol/src/newsreport.ts`**

```ts
import { z } from 'zod';
import { Emotion, Gesture, CameraCue } from './dsl.js';
import { PostProcessingSpec } from './scene.js';

/** A presenter. `avatarUrl` is a folder id (e.g. 'avaturn-model') or an http(s) URL. */
export const Anchor = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  avatarUrl: z.string().min(1),
  voiceId: z.string().min(1),
  rate: z.number().min(0.5).max(2).default(1),
  pitch: z.number().min(0.5).max(2).default(1),
});
export type Anchor = z.infer<typeof Anchor>;

export const Meta = z.object({
  title: z.string().min(1),
  anchors: z.array(Anchor).min(1),
  language: z.string().min(2).default('en'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
});
export type Meta = z.infer<typeof Meta>;

/** Set / background. MVP wires `mode` (virtual↔real → studioOn) + `backScreen`. */
export const SectionSet = z.object({
  mode: z.enum(['virtual', 'real', 'chroma', 'LED', 'AR']).default('virtual'),
  backScreen: z.object({ kind: z.enum(['url', 'r2']), src: z.string().min(1) }).optional(),
});
export type SectionSet = z.infer<typeof SectionSet>;

export const AudioCue = z.object({
  id: z.string().min(1),
  kind: z.enum(['bed', 'sfx', 'natpop']).default('bed'),
  src: z.string().min(1),
  start: z.number().min(0).default(0),
  duration: z.number().min(0).default(0),
  volume: z.number().min(0).max(1).default(0.8),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
  label: z.string().optional(),
});
export type AudioCue = z.infer<typeof AudioCue>;

export const Beat = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(2000),
  emotion: Emotion.optional(),
  gesture: Gesture.optional(),
  pause_ms_after: z.number().int().min(0).max(5000).default(0),
  camera: CameraCue.optional(),
  note: z.string().optional(), // stripped at compile; never rendered
});
export type Beat = z.infer<typeof Beat>;

/** Story forms. The MVP compiler treats every form as a straight read (READER/VO); others are accepted for forward-compat. */
export const StoryForm = z.enum(['READER', 'VO', 'VOSOT', 'PKG', 'LIVE', 'STANDUP', 'KICKER']);
export type StoryForm = z.infer<typeof StoryForm>;

export const Section = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  storyForm: StoryForm.default('READER'),
  anchorId: z.string().optional(), // MVP uses meta.anchors[0]; per-section anchor is V2
  set: SectionSet.optional(),
  cameraDefault: CameraCue.optional(),
  headline: z.string().optional(),
  beats: z.array(Beat).min(1),
  audio: z.array(AudioCue).default([]),
});
export type Section = z.infer<typeof Section>;

export const DocDefaults = z.object({
  emotion: Emotion.optional(),
  gesture: Gesture.optional(),
  pause_ms_after: z.number().int().min(0).default(0),
  camera: CameraCue.optional(),
  set: SectionSet.optional(),
  idleMotion: z.boolean().default(false),
  headline: z.string().optional(),
  music: z
    .object({
      src: z.string().min(1),
      volume: z.number().min(0).max(1).default(0.25),
      fadeIn: z.number().min(0).default(1),
      fadeOut: z.number().min(0).default(1.5),
    })
    .optional(),
});
export type DocDefaults = z.infer<typeof DocDefaults>;

export const NewsReportDoc = z.object({
  version: z.literal(2),
  meta: Meta,
  look: PostProcessingSpec.optional(),
  defaults: DocDefaults.optional(),
  rundown: z.array(Section).min(1), // MVP: single-act sugar. `acts` (setup/action/packup) deferred to V2.
});
export type NewsReportDoc = z.infer<typeof NewsReportDoc>;

/** Parse + validate untrusted input into a NewsReportDoc (throws ZodError on invalid). */
export function validateNewsReportDoc(data: unknown): NewsReportDoc {
  return NewsReportDoc.parse(data);
}
```

- [ ] **Step 3: Export from `index.ts`**

Add to `packages/protocol/src/index.ts` (next to the other `export * from`):

```ts
export * from './newsreport.js';
export * from './newsreportCompile.js';
```

- [ ] **Step 4: Register schema in `gen-schema.ts`**

In `packages/protocol/scripts/gen-schema.ts`, add `NewsReportDoc` to the import list and the `schemas` map (mirror an existing entry like `EngineRenderSpec`).

- [ ] **Step 5: Typecheck (compile-time only; `newsreportCompile.js` referenced by index doesn't exist yet → create a stub if index fails)**

If `index.ts` re-exporting `./newsreportCompile.js` breaks typecheck because the file doesn't exist yet, that's expected — Task 2 creates it. To keep T1 independently green, create `newsreportCompile.ts` as a one-line placeholder `export {};` now (Task 2 fills it), OR sequence T2 immediately after. Then:

Run: `npm run typecheck --workspace @las/protocol`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/newsreport.ts packages/protocol/src/index.ts packages/protocol/scripts/gen-schema.ts packages/protocol/src/newsreportCompile.ts
git commit -m "feat(protocol): NewsReportDoc v2 schema (MVP subset) (SP-3)"
```

---

## Task 2: Compiler — `newsreportCompile.ts` + tests

**Files:** Create/replace `packages/protocol/src/newsreportCompile.ts`; Create `packages/protocol/src/newsreport.test.ts`.

- [ ] **Step 1: Write `packages/protocol/src/newsreportCompile.ts`**

```ts
import type { NewsReportDoc, Section, Beat } from './newsreport.js';
import type { PostProcessingSpec } from './scene.js';
import type { CameraCue } from './dsl.js';

// ── Structural mirrors of avatar-live's private types (compiler stays three.js-free) ──
export type PoseTuple = [number, number, number, number, number, number, number];

export interface CompiledCue {
  id: string;
  track: 'narration' | 'camera' | 'motion' | 'audio';
  type: string;
  start: number;
  duration: number;
  pose?: PoseTuple;
  text?: string;
  gesture?: string;
  emotion?: string;
  label?: string;
  src?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface LookParams {
  bloomIntensity: number;
  bloomThreshold: number;
  contrast: number;
  saturation: number;
  vignetteOffset: number;
  vignetteDarkness: number;
  grain: number;
}

export interface CompiledProjectDoc {
  version: number;
  name: string;
  script: string;
  voiceId: string;
  rate: number;
  pitch: number;
  emotion: string;
  avatarUrl: string;
  shot: string;
  studioOn: boolean;
  idleMotion: boolean;
  headline: string;
  lights: { key: number; fill: number; rim: number; ambient: number; exposure: number; warmth: number; preset: string };
  look?: { preset?: string; params?: LookParams };
  backScreen: { kind: 'url' | 'r2'; src: string } | null;
  timeline: { duration: number; cues: CompiledCue[] };
}

const WPM = 130;
const CLOSE_SHOTS = ['close_up', 'extreme_close_up', 'medium_close'];
const WIDE_SHOTS = ['wide', 'full'];

// Lighting preset values mirror apps/avatar-live/src/app/lighting.ts LIGHT_PRESETS (kept in sync manually).
const LIGHT_VALUES: Record<string, { key: number; fill: number; rim: number; ambient: number; warmth: number }> = {
  studio: { key: 1.6, fill: 0.35, rim: 0.6, ambient: 0.45, warmth: 55 },
  soft: { key: 1.0, fill: 0.9, rim: 0.3, ambient: 0.85, warmth: 50 },
  dramatic: { key: 2.6, fill: 0.08, rim: 1.3, ambient: 0.12, warmth: 48 },
  warm: { key: 1.8, fill: 0.4, rim: 0.5, ambient: 0.5, warmth: 82 },
  cool: { key: 1.6, fill: 0.4, rim: 0.7, ambient: 0.5, warmth: 18 },
};
const LOOK_TO_LIGHT: Record<string, string> = {
  broadcast: 'studio', cinematic: 'dramatic', noir: 'dramatic', warm: 'warm', cool: 'cool', flat: 'soft', none: 'soft',
};
const DEFAULT_LOOK_PARAMS: LookParams = {
  bloomIntensity: 0.3, bloomThreshold: 0.85, contrast: 0.06, saturation: 0.06, vignetteOffset: 0.32, vignetteDarkness: 0.45, grain: 0.04,
};

function ensureTerminal(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : t + '.';
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function estDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, (words * 60) / WPM);
}
function shotFor(cam: Partial<CameraCue> | undefined): 'close' | 'medium' | 'wide' {
  const shot = cam?.shot;
  if (shot && CLOSE_SHOTS.includes(shot)) return 'close';
  if (shot && WIDE_SHOTS.includes(shot)) return 'wide';
  return 'medium';
}
function cameraTypeFor(cam: Partial<CameraCue> | undefined): string {
  if (cam?.move === 'orbit_left' || cam?.move === 'orbit_right') return 'cam.orbit';
  const s = shotFor(cam);
  return s === 'close' ? 'cam.close' : s === 'wide' ? 'cam.wide' : 'cam.anchor';
}
function motionTypeFor(gesture: string): string {
  switch (gesture) {
    case 'wave': return 'motion.wave';
    case 'point': return 'motion.point';
    case 'nod': return 'motion.nod';
    default: return 'motion.explain';
  }
}
function lookParamsFromSpec(spec: PostProcessingSpec | undefined): LookParams {
  if (!spec) return { ...DEFAULT_LOOK_PARAMS };
  return {
    bloomIntensity: spec.bloomIntensity, bloomThreshold: spec.bloomThreshold, contrast: spec.contrast,
    saturation: spec.saturation, vignetteOffset: spec.vignetteOffset, vignetteDarkness: spec.vignetteDarkness, grain: spec.grain,
  };
}
function lightsFor(lookPreset: string, exposure: number) {
  const v = LIGHT_VALUES[LOOK_TO_LIGHT[lookPreset] ?? 'studio'] ?? LIGHT_VALUES.studio;
  return { key: v.key, fill: v.fill, rim: v.rim, ambient: v.ambient, exposure, warmth: v.warmth, preset: LOOK_TO_LIGHT[lookPreset] ?? 'studio' };
}

/**
 * Lower a NewsReportDoc (v2) into the editor's ProjectDoc + Cue[]. Pure + deterministic.
 * Emits preset cam.* cue types only (no pose math — runtime poseFor() resolves them).
 * Camera = "replace + carry-forward"; emotion = sticky per section (re-seeded each section);
 * gesture = per-beat. Narration cues are advisory (Generate overwrites them).
 */
export function compileNewsReport(doc: NewsReportDoc): { project: CompiledProjectDoc; cues: CompiledCue[] } {
  const sections: Section[] = doc.rundown;
  const d = doc.defaults ?? {};
  const anchor = doc.meta.anchors[0];
  const lookPreset = doc.look?.preset ?? 'broadcast';
  const exposure = doc.look?.exposure ?? 1.05;

  const initialSet = { ...(d.set ?? { mode: 'virtual' }), ...(sections[0].set ?? {}) };
  const defEmotion: string = d.emotion ?? 'neutral';

  const cues: CompiledCue[] = [];
  const scriptParts: string[] = [];
  let t = 0;
  let cueN = 0;
  const id = (p: string) => `${p}-${cueN++}`;
  let curCamera: Partial<CameraCue> | undefined = d.camera;
  let prevCamType: string | null = null;
  let prevGesture: string | null = null;
  let firstEmotion = defEmotion;
  let firstCamera: Partial<CameraCue> | undefined = curCamera;
  let isFirstBeat = true;

  for (const section of sections) {
    if (section.cameraDefault) curCamera = section.cameraDefault;
    let curEmotion = defEmotion; // re-seed each section
    const sectionStart = t;

    for (const beat of section.beats) {
      if (beat.emotion) curEmotion = beat.emotion;
      if (beat.camera) curCamera = beat.camera;
      const gesture: string = beat.gesture ?? d.gesture ?? 'none';
      if (isFirstBeat) { firstEmotion = curEmotion; firstCamera = curCamera; isFirstBeat = false; }

      scriptParts.push(`[${curEmotion}][${gesture}] ${ensureTerminal(beat.text)}`);

      const dur = estDuration(beat.text);
      cues.push({ id: id('nar'), track: 'narration', type: 'narration', start: round1(t), duration: round1(dur), text: beat.text, gesture, emotion: curEmotion });

      const camType = cameraTypeFor(curCamera);
      if (camType !== prevCamType) {
        cues.push({ id: id('cam'), track: 'camera', type: camType, start: round1(t), duration: 1.2 });
        prevCamType = camType;
      }
      if (gesture !== 'none' && gesture !== prevGesture) {
        cues.push({ id: id('mot'), track: 'motion', type: motionTypeFor(gesture), start: round1(t), duration: 1.0 });
      }
      prevGesture = gesture;

      t += dur + (beat.pause_ms_after ?? 0) / 1000;
    }

    for (const a of section.audio) {
      cues.push({
        id: id('aud'), track: 'audio', type: 'audio.clip', start: round1(sectionStart + a.start),
        duration: round1(a.duration), src: a.src, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut, label: a.label ?? a.kind,
      });
    }
  }

  const totalDuration = round1(t);
  if (d.music) {
    cues.push({
      id: id('aud'), track: 'audio', type: 'audio.clip', start: 0, duration: totalDuration,
      src: d.music.src, volume: d.music.volume, fadeIn: d.music.fadeIn, fadeOut: d.music.fadeOut, label: 'music bed',
    });
  }

  const project: CompiledProjectDoc = {
    version: 2,
    name: doc.meta.title,
    script: scriptParts.join(' '),
    voiceId: anchor.voiceId,
    rate: anchor.rate ?? 1,
    pitch: anchor.pitch ?? 1,
    emotion: firstEmotion,
    avatarUrl: anchor.avatarUrl,
    shot: shotFor(firstCamera),
    studioOn: initialSet.mode !== 'real',
    idleMotion: d.idleMotion ?? false,
    headline: sections[0].headline ?? d.headline ?? doc.meta.title,
    lights: lightsFor(lookPreset, exposure),
    look: doc.look ? { preset: lookPreset, params: lookParamsFromSpec(doc.look) } : undefined,
    backScreen: initialSet.backScreen ?? null,
    timeline: { duration: totalDuration, cues },
  };

  return { project, cues };
}
```

> If `CameraCue`'s field names differ from `shot`/`move` when you read `dsl.ts`, adjust `shotFor`/`cameraTypeFor` accordingly (keep the cue-type outputs in the catalog set: `cam.close|cam.anchor|cam.wide|cam.orbit`).

- [ ] **Step 2: Write `packages/protocol/src/newsreport.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { validateNewsReportDoc, NewsReportDoc } from './newsreport.js';
import { compileNewsReport } from './newsreportCompile.js';

const DOC = {
  version: 2 as const,
  meta: { title: 'Evening Edition', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice_ava' }] },
  look: { preset: 'noir' as const, saturation: -1, contrast: 0.3 },
  defaults: { emotion: 'neutral' as const, music: { src: '/samples/bed.mp3' } },
  rundown: [
    {
      id: 's1', slug: 'top', storyForm: 'READER' as const, headline: 'Top story',
      beats: [
        { id: 'b1', text: 'Good evening', emotion: 'warm' as const, gesture: 'wave' as const, camera: { shot: 'close_up' as const } },
        { id: 'b2', text: 'Here is the news' },
      ],
    },
    {
      id: 's2', slug: 'two', storyForm: 'VO' as const,
      beats: [{ id: 'b3', text: 'Markets rose today', emotion: 'confident' as const, camera: { shot: 'wide' as const } }],
    },
  ],
};

describe('NewsReportDoc schema', () => {
  it('parses a valid doc + applies defaults', () => {
    const d = validateNewsReportDoc(DOC);
    expect(d.meta.fps).toBe(30); // default
    expect(d.meta.anchors[0].rate).toBe(1); // default
    expect(d.rundown).toHaveLength(2);
  });
  it('rejects an invalid emotion enum', () => {
    expect(() => validateNewsReportDoc({ ...DOC, rundown: [{ ...DOC.rundown[0], beats: [{ id: 'x', text: 'hi', emotion: 'bogus' }] }] })).toThrow();
  });
  it('rejects version != 2', () => {
    expect(() => validateNewsReportDoc({ ...DOC, version: 1 })).toThrow();
  });
});

describe('compileNewsReport', () => {
  const { project, cues } = compileNewsReport(NewsReportDoc.parse(DOC));
  it('sets doc-level scalars from anchors[0] + meta', () => {
    expect(project.name).toBe('Evening Edition');
    expect(project.voiceId).toBe('voice_ava');
    expect(project.avatarUrl).toBe('avaturn-model');
    expect(project.emotion).toBe('warm'); // first beat resolved
    expect(project.shot).toBe('close'); // first beat close_up
    expect(project.headline).toBe('Top story');
  });
  it('renders beats to a sentence-split script with inline [emotion][gesture] tags', () => {
    expect(project.script).toContain('[warm][wave] Good evening.');
    expect(project.script).toContain('[warm][none] Here is the news.'); // emotion sticky in section, gesture per-beat
    expect(project.script).toContain('[confident][none] Markets rose today.');
  });
  it('emits a camera cue on change + a motion cue on gesture', () => {
    const cam = cues.filter((c) => c.track === 'camera');
    expect(cam[0].type).toBe('cam.close'); // first beat
    expect(cam.some((c) => c.type === 'cam.wide')).toBe(true); // section 2 wide
    expect(cues.some((c) => c.track === 'motion' && c.type === 'motion.wave')).toBe(true);
  });
  it('bridges the flat look spec into ProjectDoc.look.params + lights', () => {
    expect(project.look?.preset).toBe('noir');
    expect(project.look?.params?.saturation).toBe(-1);
    expect(project.lights.preset).toBe('dramatic'); // noir → dramatic
  });
  it('emits a music bed audio cue spanning the timeline', () => {
    const bed = cues.find((c) => c.track === 'audio' && c.label === 'music bed');
    expect(bed?.start).toBe(0);
    expect(bed?.duration).toBe(project.timeline.duration);
  });
  it('narration cue count == beat count', () => {
    expect(cues.filter((c) => c.track === 'narration')).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck --workspace @las/protocol && npm test --workspace @las/protocol -- newsreport.test.ts`
Expected: typecheck PASS; all tests PASS. If a `PostProcessingSpec` field name differs, fix `lookParamsFromSpec`; if a test assertion reveals a real lowering bug, fix the **compiler** (not the test) to match the §6 rules.

- [ ] **Step 4: Full protocol test + schema regen**

Run: `npm test --workspace @las/protocol && npm run protocol:schema`
Expected: all protocol tests PASS; schema regenerates (NewsReportDoc emitted; `dist/schema/` is gitignored — don't commit it).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/newsreportCompile.ts packages/protocol/src/newsreport.test.ts
git commit -m "feat(protocol): compileNewsReport lowering + golden tests (SP-3)"
```

---

## Task 3: Import wiring in `projectStore.ts`

**Files:** Modify `apps/avatar-live/src/app/projectStore.ts`.

- [ ] **Step 1: Import the protocol functions**

At the top of `projectStore.ts`, add:

```ts
import { validateNewsReportDoc, compileNewsReport } from '@las/protocol';
```

- [ ] **Step 2: Add the discriminator branch**

Read the file import handler (the `d.timelineFileEl` change handler, ~line 240-260) where it currently distinguishes a full ProjectDoc vs a bare timeline. Add a **NewsReportDoc branch FIRST** (most specific). Locate the existing discrimination (something like `const isProject = ...; const isTimeline = ...;`) and prepend:

```ts
    const isObj = data && typeof data === 'object';
    const isNewsReport = isObj && (data as { version?: unknown }).version === 2 && (data as { meta?: unknown }).meta
      && Array.isArray((data as { rundown?: unknown }).rundown);
    if (isNewsReport) {
      const { project } = compileNewsReport(validateNewsReportDoc(data));
      await this.applyProject(project as unknown as Parameters<ProjectStore['applyProject']>[0]);
      this.app.log(`imported newscast: ${(data as { meta: { title?: string } }).meta.title ?? 'untitled'}`);
      return;
    }
```

> `applyProject` is a method on this class so it's callable here. `compileNewsReport` returns `CompiledProjectDoc` (structural ProjectDoc) — the `as unknown as` cast bridges the structurally-identical private `ProjectDoc` type. If `applyProject` is `private`, calling it from within the same class is fine. Match the exact variable/return style of the surrounding handler (e.g. if it sets `d.projectNameEl.value`, do that with `data.meta.title`).

- [ ] **Step 3: Verify**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS. If `@las/protocol` doesn't resolve `compileNewsReport`/`validateNewsReportDoc`, confirm Task 1 Step 3 exported them and rebuild protocol (`npm run build --workspace @las/protocol` if the workspace consumes built output; otherwise Vite resolves TS source).

- [ ] **Step 4: Commit**

```bash
git add apps/avatar-live/src/app/projectStore.ts
git commit -m "feat(avatar-live): import NewsReportDoc → compile → applyProject (SP-3)"
```

---

## Task 4: Sample doc + end-to-end smoke

**Files:** Create `apps/avatar-live/public/samples/showcase.newscast.json`.

- [ ] **Step 1: Author the sample**

Create `apps/avatar-live/public/samples/showcase.newscast.json` (use a real avatar folder id + a real ElevenLabs `voiceId` present in the deployed editor):

```json
{
  "version": 2,
  "meta": {
    "title": "Evening Edition — Showcase",
    "anchors": [{ "id": "ava", "name": "Ava Lin", "avatarUrl": "avaturn-model", "voiceId": "EXAVITQu4vr4xnSDxMaL" }]
  },
  "look": { "preset": "broadcast" },
  "defaults": { "emotion": "neutral", "idleMotion": true },
  "rundown": [
    {
      "id": "open", "slug": "cold-open", "storyForm": "READER", "headline": "Evening Edition",
      "beats": [
        { "id": "o1", "text": "Good evening, and welcome to the broadcast.", "emotion": "warm", "gesture": "open_palms", "camera": { "shot": "medium" } },
        { "id": "o2", "text": "Here are tonight's top stories.", "emotion": "confident", "camera": { "shot": "close_up" } }
      ]
    },
    {
      "id": "markets", "slug": "markets", "storyForm": "VO", "headline": "Markets close higher",
      "beats": [
        { "id": "m1", "text": "Wall Street ended the day in the green.", "emotion": "confident", "gesture": "point", "camera": { "shot": "wide" } },
        { "id": "m2", "text": "Tech shares led the gains across the board.", "emotion": "happy" }
      ]
    },
    {
      "id": "kicker", "slug": "sign-off", "storyForm": "READER", "headline": "Goodnight",
      "beats": [{ "id": "k1", "text": "That's all for tonight. Thanks for watching.", "emotion": "warm", "gesture": "wave", "camera": { "shot": "close_up" } }]
    }
  ]
}
```

- [ ] **Step 2: Typecheck/build (sample is static; just confirm nothing broke)**

Run: `npm run build --workspace @las/avatar-live`
Expected: PASS (the JSON ships under `public/`).

- [ ] **Step 3: Manual E2E smoke (the acceptance test)**

1. `npm run dev:avatar` → http://localhost:5175.
2. Import the sample via the timeline/project file input (the control bound to `timelineFileEl`) — pick `public/samples/showcase.newscast.json`. (Or in console: `fetch('/samples/showcase.newscast.json').then(r=>r.json())` and feed it through the import path.)
3. Confirm the editor reconfigured: the **script box** is populated with the three sections' sentences carrying `[emotion][gesture]` tags; the **headline** shows "Evening Edition"; the **look** is Broadcast; the avatar is the Avaturn model; the timeline has **camera** cues (medium→close→wide→close) + **motion** cues (open_palms/point/wave).
4. Click **Generate** (narration via the selected ElevenLabs voice), then **⬇ Export MP4** (720p/H.264).
5. The exported MP4 plays the scripted performance with synced audio + the broadcast look.

Expected: a real avatar/camera/look performance from the imported document — not a placeholder. Confirm via the same blob-inspection technique used for SP-1 (duration, dimensions, audio track) if desired.

- [ ] **Step 4: Commit**

```bash
git add apps/avatar-live/public/samples/showcase.newscast.json
git commit -m "feat(avatar-live): showcase NewsReportDoc sample + E2E import (SP-3)"
```

---

## Task 5: Docs + validation log

**Files:** Modify `apps/avatar-live/README.md`, `progress.md`.

- [ ] **Step 1: README — add a "Newscast script (import)" subsection**

```markdown
### Newscast script (import)

Import a `NewsReportDoc` (v2 JSON, `@las/protocol`) via the project/timeline file input to
configure the whole editor at once: anchor + voice, the script (sections → beats with inline
`[emotion][gesture]` tags), headline, look, lighting, back-screen, and camera/motion/music
cues. Then **Generate** + **⬇ Export MP4**. See `public/samples/showcase.newscast.json` and
`docs/specs/2026-06-21-newscast-dsl-design.md`. MVP supports a `rundown` of READER/VO sections;
acts/graphics/ticker/transitions/`.ncast` text are V2.
```

- [ ] **Step 2: progress.md — append the SP-3 line**

```markdown
- 2026-06-22 — SP-3 (Newscast DSL): the language MVP. `NewsReportDoc` v2 schema + pure
  `compileNewsReport` lowering (→ ProjectDoc + Cue[]) in `@las/protocol` (vitest golden tests);
  avatar-live import discriminator compiles an imported `.newscast.json` → applyProject →
  Generate → Export MP4 (reuses SP-1 export + SP-2 look). Acts/graphics/transitions/`.ncast`
  deferred to V2 per §9.5. Validated via protocol tests + manual studio import→export smoke.
```

- [ ] **Step 3: Commit**

```bash
git add apps/avatar-live/README.md progress.md
git commit -m "docs: document NewsReportDoc import + SP-3 validation (SP-3)"
```

---

## Self-Review

**Spec coverage (§2/§7/§9.5 MVP):** schema (`NewsReportDoc` MVP subset) → T1; pure compiler lowering (§7 rules: act-normalization-as-single-act, sticky emotion/camera, beat→script tags, camera/motion/audio cues, look bridge, doc scalars) → T2 + golden tests; import discriminator → T3; configure-editor→Generate→Export reuses SP-1/SP-2 → T3/T4; sample + E2E → T4; docs → T5. Deferred items (acts/StageOp, graphics, transitions, multi-anchor, `.ncast`, TS builder, SSML, captions) explicitly out of MVP per §9.5.

**Placeholder scan:** all new files have complete code; existing-file edits give exact insert snippets + locations; the only flagged uncertainty (CameraCue field names, PostProcessingSpec field names) is gated by typecheck + the golden test with explicit "fix against source" instructions.

**Type consistency:** `NewsReportDoc`/`Section`/`Beat`/`AudioCue` (T1) consumed by `compileNewsReport` (T2) and the sample (T4). `compileNewsReport(doc): { project: CompiledProjectDoc; cues: CompiledCue[] }` (T2) called in projectStore (T3). `CompiledProjectDoc` mirrors the real `ProjectDoc` (recon §1a) — the `as unknown as` cast in T3 bridges the structurally-identical private type. `LookParams` mirror (T2) matches avatar-live's `lookChain.LookParams`. Cue `type` values restricted to the catalog set (recon §1d). Script format matches the narration contract (recon §3: sentence-split + first `[emotion]`/`[gesture]`).
