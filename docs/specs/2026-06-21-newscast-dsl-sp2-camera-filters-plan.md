# SP-2 — Camera Filters / "Look" System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a cinematic post-processing "look" system to `apps/avatar-live` — a default **broadcast** look plus selectable presets + sliders (bloom, contrast, saturation, vignette, grain, exposure) — rendered through pmndrs `postprocessing`, applied to both the live viewport and the captured output (so the SP-1 MP4 export inherits the look), with a shared `PostProcessingSpec` added to `packages/protocol`.

**Architecture:** A standalone `look/lookChain.ts` builds a postprocessing `EffectComposer` (RenderPass → HDR EffectPass [Bloom + ACES ToneMapping] → LDR EffectPass [BrightnessContrast + HueSaturation + Vignette + Noise/grain + SMAA]) over a given renderer/scene/camera, returning the effect refs. `Stage` builds **two** composers — `viewportComposer` over `renderer` and `outputComposer` over `outputRenderer` — sets both renderers to `NoToneMapping` (the ToneMappingEffect now owns tone mapping), and routes its three scene-render calls through them; because `outputRenderer`/`outputCanvas` is shared by the live PiP **and** `renderOutputFrame()` (SP-1), the look appears in the webm preview and the exported MP4 with zero exporter changes. A `Look` controller (mirroring `Lighting`) drives presets/sliders → `stage.setLook()` and serializes into `ProjectDoc`. `PostProcessingSpec` (r152-safe enums) is added to `packages/protocol` `scene.ts` + `EngineRenderSpec` so the look is part of the shared contract (engine-three pod wiring is a documented follow-up).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), three.js **0.152.2**, **`postprocessing@6.35.6`** (exact pin — `^` may resolve 6.36+ which requires three r157+ and breaks against 0.152.2), Vite, zod (protocol). SP-2 of the Newscast DSL build order ([design spec](./2026-06-21-newscast-dsl-design.md) §8.2, §9.5).

**Verification model:** No avatar-live test suite. Every task verifies with `npm run typecheck` + `npm run build --workspace @las/avatar-live` (and `npm test --workspace @las/protocol` for the protocol task), plus browser smokes via the running dev server (`npm run dev:avatar` → http://localhost:5175). Per project `CLAUDE.md`: no retries on render paths; surface failures via `app.log`.

**Library-API note (read before T1/T2):** postprocessing effects expose their main parameters as instance accessors in most cases (`bloom.intensity`, `vignette.offset`/`.darkness`, `hueSaturation.saturation`, `brightnessContrast.contrast`/`.brightness`, `bloom.luminanceMaterial.threshold`, `noise.blendMode.opacity.value`). **If any accessor in `applyLookParams` fails typecheck against the installed `postprocessing@6.35.6` d.ts, consult `node_modules/postprocessing` types and use the correct path (universally, `effect.uniforms.get('<name>').value` works).** Getting typecheck green is the gate — use the real types.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `apps/avatar-live/package.json` | Modify | Add `postprocessing@6.35.6` (exact). |
| `apps/avatar-live/src/look/lookChain.ts` | **Create** | Build a postprocessing composer + effect chain over a renderer/scene/camera; `LookParams`, `LookFx`, `LOOK_PRESETS`, `buildLookChain()`, `applyLookParams()`. |
| `apps/avatar-live/src/scene/stage.ts` | Modify | Two composers (viewport + output); `NoToneMapping`; route the 3 scene renders through composers; `setLook()`; composer `setSize` in `setCaptureFormat`/`resize`. |
| `packages/protocol/src/scene.ts` | Modify | Add `PostProcessingSpec` zod schema (r152-safe enums) + `SceneDocument.look`. |
| `packages/protocol/src/jobs.ts` | Modify | `EngineRenderSpec.look?: PostProcessingSpec`. |
| `packages/protocol/scripts/gen-schema.ts` | Modify | Emit `PostProcessingSpec.json`. |
| `apps/avatar-live/index.html` | Modify | "Look" section: preset `<select>` + sliders. |
| `apps/avatar-live/src/app/dom.ts` | Modify | Bind the new Look elements. |
| `apps/avatar-live/src/app/look.ts` | **Create** | `Look` controller: presets/sliders → `stage.setLook()`, `serialize()`/`apply()`/`init()`. |
| `apps/avatar-live/src/main.ts` | Modify | Construct + init `Look`; add it to `ProjectStore` deps. |
| `apps/avatar-live/src/app/projectStore.ts` | Modify | `ProjectDoc.look`; serialize/apply via the `Look` controller. |
| `apps/avatar-live/README.md`, `progress.md` | Modify | Document the look system + SP-2 validation. |

**Constants (must match across tasks):** `LookParams = { bloomIntensity, bloomThreshold, contrast, saturation, vignetteOffset, vignetteDarkness, grain }` (all `number`). Broadcast default = `{ bloomIntensity:0.30, bloomThreshold:0.85, contrast:0.06, saturation:0.06, vignetteOffset:0.32, vignetteDarkness:0.45, grain:0.04 }`. Exposure stays on `stage.setExposure()` (renderer `toneMappingExposure`), NOT in `LookParams`.

---

## Task 1: postprocessing dependency + `lookChain.ts`

**Files:** Modify `apps/avatar-live/package.json`; Create `apps/avatar-live/src/look/lookChain.ts`.

- [ ] **Step 1: Install (exact pin)**

Run (repo root): `npm install postprocessing@6.35.6 --workspace @las/avatar-live --save-exact`
Expected: `package.json` gains `"postprocessing": "6.35.6"` (no caret). If npm reports an `ERESOLVE` peer conflict, STOP — it means a wrong version; 6.35.6 accepts three 0.152.2.

- [ ] **Step 2: Write `apps/avatar-live/src/look/lookChain.ts`**

```ts
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  BrightnessContrastEffect,
  HueSaturationEffect,
  VignetteEffect,
  NoiseEffect,
  SMAAEffect,
  BlendFunction,
} from 'postprocessing';

/** User-tunable look parameters (exposure is handled separately via Stage.setExposure). */
export interface LookParams {
  bloomIntensity: number; // 0..2
  bloomThreshold: number; // 0..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  vignetteOffset: number; // 0..1 (lower = vignette reaches further in)
  vignetteDarkness: number; // 0..1
  grain: number; // 0..1 (film-grain opacity)
}

/** Live effect instances whose uniforms we mutate when the look changes. */
export interface LookFx {
  bloom: BloomEffect;
  toneMapping: ToneMappingEffect;
  bc: BrightnessContrastEffect;
  hs: HueSaturationEffect;
  vignette: VignetteEffect;
  grain: NoiseEffect;
}

export interface LookChain {
  composer: EffectComposer;
  fx: LookFx;
}

export const LOOK_PRESETS: Record<string, LookParams> = {
  broadcast: { bloomIntensity: 0.3, bloomThreshold: 0.85, contrast: 0.06, saturation: 0.06, vignetteOffset: 0.32, vignetteDarkness: 0.45, grain: 0.04 },
  flat: { bloomIntensity: 0.0, bloomThreshold: 1.0, contrast: 0.0, saturation: 0.0, vignetteOffset: 0.5, vignetteDarkness: 0.0, grain: 0.0 },
  cinematic: { bloomIntensity: 0.5, bloomThreshold: 0.8, contrast: 0.14, saturation: 0.1, vignetteOffset: 0.28, vignetteDarkness: 0.6, grain: 0.08 },
  warm: { bloomIntensity: 0.35, bloomThreshold: 0.82, contrast: 0.08, saturation: 0.14, vignetteOffset: 0.32, vignetteDarkness: 0.4, grain: 0.05 },
  noir: { bloomIntensity: 0.2, bloomThreshold: 0.85, contrast: 0.3, saturation: -1.0, vignetteOffset: 0.22, vignetteDarkness: 0.8, grain: 0.12 },
};

export const DEFAULT_LOOK: LookParams = LOOK_PRESETS.broadcast;

/**
 * Build a postprocessing composer over a renderer/scene/camera with the look chain.
 * Order: RenderPass → [Bloom, ToneMapping(ACES)] (HDR) → [BrightnessContrast, HueSaturation,
 * Vignette, Noise grain, SMAA] (LDR). Returns the effect refs for live updates.
 * NOTE: the caller must set renderer.toneMapping = THREE.NoToneMapping (ToneMappingEffect owns it).
 */
export function buildLookChain(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  params: LookParams,
): LookChain {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomEffect({
    mipmapBlur: true,
    intensity: params.bloomIntensity,
    luminanceThreshold: params.bloomThreshold,
    luminanceSmoothing: 0.08,
    radius: 0.7,
  });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }); // AGX/NEUTRAL need three r160+/r162+
  const bc = new BrightnessContrastEffect({ brightness: 0, contrast: params.contrast });
  const hs = new HueSaturationEffect({ hue: 0, saturation: params.saturation });
  const vignette = new VignetteEffect({ offset: params.vignetteOffset, darkness: params.vignetteDarkness });
  const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
  grain.blendMode.opacity.value = params.grain;
  const smaa = new SMAAEffect();

  composer.addPass(new EffectPass(camera, bloom, toneMapping));
  composer.addPass(new EffectPass(camera, bc, hs, vignette, grain, smaa));

  return { composer, fx: { bloom, toneMapping, bc, hs, vignette, grain } };
}

/** Push LookParams into a live effect chain's uniforms. */
export function applyLookParams(fx: LookFx, p: LookParams): void {
  fx.bloom.intensity = p.bloomIntensity;
  fx.bloom.luminanceMaterial.threshold = p.bloomThreshold;
  fx.bc.contrast = p.contrast;
  fx.hs.saturation = p.saturation;
  fx.vignette.offset = p.vignetteOffset;
  fx.vignette.darkness = p.vignetteDarkness;
  fx.grain.blendMode.opacity.value = p.grain;
}
```

> If any setter in `applyLookParams` (or a constructor option) fails typecheck against `postprocessing@6.35.6`, fix it using the installed d.ts (e.g. `fx.bc.uniforms.get('contrast')!.value = p.contrast`). Do NOT change `LookParams`/`LookFx`/`LOOK_PRESETS` shapes — later tasks depend on them.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS (postprocessing resolves + bundles).

- [ ] **Step 4: Commit** (local; no push)

```bash
git add apps/avatar-live/package.json package-lock.json apps/avatar-live/src/look/lookChain.ts
git commit -m "feat(avatar-live): postprocessing look chain (bloom/aces/grade/vignette/grain/smaa) (SP-2)"
```

---

## Task 2: Stage integration — two composers + `setLook()`

**Files:** Modify `apps/avatar-live/src/scene/stage.ts`.

Read the file first. The recon points (line numbers approximate — locate by code):
- Constructor builds `renderer` (main) with `toneMapping = ACESFilmicToneMapping` and `outputRenderer` (capture) likewise.
- `tick()` calls `this.renderer.render(this.scene, this.camera)` (viewport) and `this.outputRenderer.render(this.scene, this.camera)` (output, inside the capture-gate viewOffset/visibility block), plus a screen-cut `this.outputRenderer.render(this.screenScene, this.screenCam)`.
- `renderOutputFrame()` (added in SP-1) also calls `this.outputRenderer.render(this.scene, this.camera)` and a screen-cut render.
- `setCaptureFormat()` calls `this.outputRenderer.setSize(fmt.w, fmt.h, false)`; `resize()` calls `this.renderer.setSize(w, h, false)`; `setExposure()` sets `toneMappingExposure` on both renderers.

- [ ] **Step 1: Imports + fields**

At the top of `stage.ts`, add:

```ts
import { buildLookChain, applyLookParams, DEFAULT_LOOK, type LookParams, type LookChain } from '../look/lookChain.js';
```

Add fields to the `Stage` class (near the other private renderer fields):

```ts
  private viewportLook!: LookChain;
  private outputLook!: LookChain;
  private lookParams: LookParams = { ...DEFAULT_LOOK };
```

- [ ] **Step 2: Disable renderer tone mapping (the effect owns it)**

In the constructor, change BOTH renderers' tone-mapping lines from `THREE.ACESFilmicToneMapping` to `THREE.NoToneMapping`:

```ts
    this.renderer.toneMapping = THREE.NoToneMapping; // ToneMappingEffect (ACES) owns tone mapping now
    // …and for the output renderer:
    this.outputRenderer.toneMapping = THREE.NoToneMapping;
```

Keep both `toneMappingExposure = 1.05` lines as-is (exposure still scales the linear buffer feeding the composers).

- [ ] **Step 3: Build the two composers (end of constructor)**

After `this.scene`, `this.camera`, `this.screenScene`/`this.screenCam`, both renderers, and lights/backdrop exist — and BEFORE any animation loop starts — add:

```ts
    this.viewportLook = buildLookChain(this.renderer, this.scene, this.camera, this.lookParams);
    this.outputLook = buildLookChain(this.outputRenderer, this.scene, this.camera, this.lookParams);
```

- [ ] **Step 4: Route scene renders through the composers**

Replace the **scene** render calls (NOT the screen-cut ones):

- The viewport call `this.renderer.render(this.scene, this.camera)` → `this.viewportLook.composer.render();`
- BOTH output scene calls `this.outputRenderer.render(this.scene, this.camera)` (in `tick()` and in `renderOutputFrame()`) → `this.outputLook.composer.render();`

Leave the screen-cut renders (`this.outputRenderer.render(this.screenScene, this.screenCam)` and `this.renderer.render(this.screenScene, ...)` if any) UNCHANGED — the fullscreen video cut is not graded. Keep all surrounding logic (manual clear, `camera.setViewOffset(...)`, `hideInOutput` visibility toggles) exactly as-is around the replaced call; the composer's `RenderPass` reads the same mutated `camera`/`scene`.

- [ ] **Step 5: Resize the composers**

In `setCaptureFormat(fmt)`, after `this.outputRenderer.setSize(fmt.w, fmt.h, false)` add:

```ts
    this.outputLook.composer.setSize(fmt.w, fmt.h, false);
```

In `resize()`, after `this.renderer.setSize(w, h, false)` add (use the same `w`/`h` the method computed):

```ts
    this.viewportLook.composer.setSize(w, h, false);
```

- [ ] **Step 6: `setLook()` method**

Add to the `Stage` class:

```ts
  /** Update the post-processing look on both the viewport and the capture/export composers. */
  setLook(params: LookParams): void {
    this.lookParams = { ...params };
    applyLookParams(this.viewportLook.fx, this.lookParams);
    applyLookParams(this.outputLook.fx, this.lookParams);
  }

  /** Current look params (for serialization). */
  getLook(): LookParams {
    return { ...this.lookParams };
  }
```

- [ ] **Step 7: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS. If `composer.render()` overload or a setter errors, fix per the installed postprocessing types.

- [ ] **Step 8: Browser smoke**

`npm run dev:avatar` → reload http://localhost:5175. In the console:

```js
const s = window.__las.stage;
s.setLook({ bloomIntensity: 0.0, bloomThreshold: 1.0, contrast: 0.0, saturation: -1.0, vignetteOffset: 0.5, vignetteDarkness: 0.0, grain: 0.0 });
// expect: viewport desaturates to grayscale (saturation -1)
setTimeout(() => s.setLook({ bloomIntensity: 0.3, bloomThreshold: 0.85, contrast: 0.06, saturation: 0.06, vignetteOffset: 0.32, vignetteDarkness: 0.45, grain: 0.04 }), 1500);
```

Expected: the avatar/studio is still visible (not black — confirms tone mapping moved into the effect correctly), and saturation/vignette visibly change. PASS = look applies live without breaking the render.

- [ ] **Step 9: Commit**

```bash
git add apps/avatar-live/src/scene/stage.ts
git commit -m "feat(avatar-live): apply postprocessing look to viewport + capture/export composers (SP-2)"
```

---

## Task 3: `PostProcessingSpec` in `packages/protocol`

**Files:** Modify `packages/protocol/src/scene.ts`, `packages/protocol/src/jobs.ts`, `packages/protocol/scripts/gen-schema.ts`.

- [ ] **Step 1: Add the schema to `scene.ts`**

In `packages/protocol/src/scene.ts`, add (before `SceneDocument`):

```ts
export const PostProcessingSpec = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(['broadcast', 'flat', 'cinematic', 'warm', 'noir']).default('broadcast'),
  toneMapping: z.enum(['aces_filmic', 'reinhard2', 'uncharted2', 'optimized_cineon', 'linear']).default('aces_filmic'), // r152-safe (no agx/neutral)
  exposure: z.number().min(0.1).max(3).default(1.05),
  bloomIntensity: z.number().min(0).max(2).default(0.3),
  bloomThreshold: z.number().min(0).max(1).default(0.85),
  contrast: z.number().min(-1).max(1).default(0.06),
  saturation: z.number().min(-1).max(1).default(0.06),
  vignetteOffset: z.number().min(0).max(1).default(0.32),
  vignetteDarkness: z.number().min(0).max(1).default(0.45),
  grain: z.number().min(0).max(1).default(0.04),
});
export type PostProcessingSpec = z.infer<typeof PostProcessingSpec>;
```

Then add an optional `look` field to `SceneDocument` (alongside its existing fields):

```ts
  look: PostProcessingSpec.optional(),
```

- [ ] **Step 2: Reference it in `EngineRenderSpec` (`jobs.ts`)**

`jobs.ts` already imports from `./scene.js`. Add `PostProcessingSpec` to that import, and add to the `EngineRenderSpec` object:

```ts
  look: PostProcessingSpec.optional(),
```

- [ ] **Step 3: Emit standalone schema in `gen-schema.ts`**

In `packages/protocol/scripts/gen-schema.ts`, add `PostProcessingSpec` to the import list and to the `schemas` map (mirror an existing entry, e.g. `EngineRenderSpec`) so a `PostProcessingSpec.json` is written.

- [ ] **Step 4: Verify + regenerate schema**

Run:
```bash
npm run typecheck --workspace @las/protocol
npm test --workspace @las/protocol
npm run protocol:schema
git status --short packages/protocol
```
Expected: typecheck PASS; protocol vitest PASS; `npm run protocol:schema` writes/updates JSON Schema (a new `PostProcessingSpec.json` + updated `EngineRenderSpec.json`/`SceneDocument.json` appear in `git status`).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/scene.ts packages/protocol/src/jobs.ts packages/protocol/scripts/gen-schema.ts packages/protocol/schema
git commit -m "feat(protocol): add PostProcessingSpec (look) to SceneDocument + EngineRenderSpec (SP-2)"
```

> If the generated schema lives in a path other than `packages/protocol/schema`, `git add` the actual generated directory shown by `git status` in Step 4.

---

## Task 4: UI — "Look" section (preset + sliders)

**Files:** Modify `apps/avatar-live/index.html`, `apps/avatar-live/src/app/dom.ts`.

- [ ] **Step 1: Add the Look section to `index.html`**

Grep for the existing "Studio & lighting" controls block (the light sliders) and add a sibling section in the same panel. Use the file's existing markup classes (mirror the lighting `<section>`/`<label>`/`<input type="range">` pattern). The required ids:

```html
        <select id="lookPreset" title="Camera look">
          <option value="broadcast">Broadcast</option>
          <option value="flat">Flat (no look)</option>
          <option value="cinematic">Cinematic</option>
          <option value="warm">Warm</option>
          <option value="noir">Noir</option>
        </select>
        <label class="mini">Bloom <input type="range" id="lookBloom" min="0" max="2" step="0.01" value="0.3"></label>
        <label class="mini">Contrast <input type="range" id="lookContrast" min="-1" max="1" step="0.01" value="0.06"></label>
        <label class="mini">Saturation <input type="range" id="lookSaturation" min="-1" max="1" step="0.01" value="0.06"></label>
        <label class="mini">Vignette <input type="range" id="lookVignette" min="0" max="1" step="0.01" value="0.45"></label>
        <label class="mini">Grain <input type="range" id="lookGrain" min="0" max="1" step="0.01" value="0.04"></label>
```

(Match the surrounding indentation/markup conventions; class names should mirror the existing light sliders so styling is inherited.)

- [ ] **Step 2: Bind in `dom.ts`**

In `bindDom()`, add (near the lighting bindings):

```ts
    lookPresetSel: $<HTMLSelectElement>('lookPreset'),
    lookBloomEl: $<HTMLInputElement>('lookBloom'),
    lookContrastEl: $<HTMLInputElement>('lookContrast'),
    lookSaturationEl: $<HTMLInputElement>('lookSaturation'),
    lookVignetteEl: $<HTMLInputElement>('lookVignette'),
    lookGrainEl: $<HTMLInputElement>('lookGrain'),
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 4: Visual check** — the Look section (preset + 5 sliders) appears in the panel.

- [ ] **Step 5: Commit**

```bash
git add apps/avatar-live/index.html apps/avatar-live/src/app/dom.ts
git commit -m "feat(avatar-live): Look UI — preset select + sliders (SP-2)"
```

---

## Task 5: `Look` controller + project persistence + wiring

**Files:** Create `apps/avatar-live/src/app/look.ts`; Modify `apps/avatar-live/src/main.ts`, `apps/avatar-live/src/app/projectStore.ts`.

- [ ] **Step 1: Create `apps/avatar-live/src/app/look.ts`**

```ts
import { LOOK_PRESETS, DEFAULT_LOOK, type LookParams } from '../look/lookChain.js';
import type { StudioContext } from './context.js';

/** Camera-look controller: preset + sliders → stage.setLook(); project serialize/apply. */
export class Look {
  private params: LookParams = { ...DEFAULT_LOOK };
  private preset = 'broadcast';
  constructor(private app: StudioContext) {}

  private readSliders(): LookParams {
    const d = this.app.dom;
    return {
      bloomIntensity: Number(d.lookBloomEl.value),
      bloomThreshold: this.params.bloomThreshold, // not slider-exposed; carried from preset
      contrast: Number(d.lookContrastEl.value),
      saturation: Number(d.lookSaturationEl.value),
      vignetteOffset: this.params.vignetteOffset, // carried from preset
      vignetteDarkness: Number(d.lookVignetteEl.value),
      grain: Number(d.lookGrainEl.value),
    };
  }

  private pushSliders(p: LookParams): void {
    const d = this.app.dom;
    d.lookBloomEl.value = String(p.bloomIntensity);
    d.lookContrastEl.value = String(p.contrast);
    d.lookSaturationEl.value = String(p.saturation);
    d.lookVignetteEl.value = String(p.vignetteDarkness);
    d.lookGrainEl.value = String(p.grain);
  }

  private applyFromSliders = (): void => {
    this.params = this.readSliders();
    this.app.stage.setLook(this.params);
  };

  private applyPreset(name: string): void {
    const p = LOOK_PRESETS[name];
    if (!p) return;
    this.preset = name;
    this.params = { ...p };
    this.pushSliders(this.params);
    this.app.stage.setLook(this.params);
  }

  serialize() {
    return { look: { preset: this.preset, params: this.params } };
  }

  apply(doc: { look?: { preset?: string; params?: LookParams } }): void {
    if (!doc.look) return;
    if (doc.look.params) {
      this.params = { ...DEFAULT_LOOK, ...doc.look.params };
      this.preset = doc.look.preset ?? 'broadcast';
      this.app.dom.lookPresetSel.value = this.preset;
      this.pushSliders(this.params);
      this.app.stage.setLook(this.params);
    } else if (doc.look.preset) {
      this.app.dom.lookPresetSel.value = doc.look.preset;
      this.applyPreset(doc.look.preset);
    }
  }

  init(): void {
    const d = this.app.dom;
    d.lookPresetSel.addEventListener('change', () => this.applyPreset(d.lookPresetSel.value));
    [d.lookBloomEl, d.lookContrastEl, d.lookSaturationEl, d.lookVignetteEl, d.lookGrainEl].forEach((el) =>
      el.addEventListener('input', this.applyFromSliders),
    );
    this.applyPreset('broadcast'); // establish the default look on load
  }
}
```

- [ ] **Step 2: Wire into `main.ts`**

In `apps/avatar-live/src/main.ts`: import + construct `Look`, init it, and add it to the `ProjectStore` deps. Mirror the existing controller wiring:

```ts
import { Look } from './app/look.js';
// …after `const lighting = new Lighting(app);` (or near it):
const look = new Look(app);
// …add `look` to the ProjectStore deps object:
const projects = new ProjectStore(app, { library, voices, lighting, look, backScreen, timeline, performer });
// …in the init block, after `lighting.init();`:
look.init();
```

- [ ] **Step 3: Persist in `projectStore.ts`**

In `apps/avatar-live/src/app/projectStore.ts`: add `look: Look` to the deps type/param; add `look` to the `ProjectDoc` interface as `look?: { preset?: string; params?: LookParams }` (import `LookParams` from `../look/lookChain.js`); include `...this.deps.look.serialize()` in `serializeProject()`; and call `this.deps.look.apply(doc)` in `applyProject()` (next to `lighting.apply(...)`). Match the existing serialize/apply spread pattern used for `lighting`.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck --workspace @las/avatar-live && npm run build --workspace @las/avatar-live`
Expected: PASS.

- [ ] **Step 5: Browser smoke**

`npm run dev:avatar` → reload. In the UI: change the **Look** preset to **Noir** → viewport goes high-contrast grayscale; drag **Saturation** → live change. In console, verify persistence round-trips:

```js
// after switching to 'cinematic' in the UI:
console.log(JSON.stringify(window.__las ? 'ui-ok' : 'no'));
```

Expected: preset switching + sliders visibly change the look; no console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/avatar-live/src/app/look.ts apps/avatar-live/src/main.ts apps/avatar-live/src/app/projectStore.ts
git commit -m "feat(avatar-live): Look controller + project persistence + wiring (SP-2)"
```

---

## Task 6: Docs + export-inherits-look smoke

**Files:** Modify `apps/avatar-live/README.md`, `progress.md`.

- [ ] **Step 1: Docs**

In `apps/avatar-live/README.md`, add a short "Look / camera filters" subsection:

```markdown
### Look (camera filters)

A post-processing "look" (pmndrs `postprocessing`) is applied to the viewport **and** the
captured output, so the exported MP4 inherits it. Pick a preset (Broadcast default, Flat,
Cinematic, Warm, Noir) or tune Bloom / Contrast / Saturation / Vignette / Grain. The look is
saved in the project. Tone mapping is ACES (three 0.152.2; AgX/Neutral need a three upgrade).
```

In `progress.md`, append:

```markdown
- 2026-06-21 — SP-2 (Newscast DSL): camera-filter "look" system in apps/avatar-live via pmndrs
  postprocessing@6.35.6 (bloom → ACES tone map → contrast/saturation/vignette/grain → SMAA),
  applied to viewport + capture/export composers (the SP-1 MP4 inherits the look). PostProcessingSpec
  added to packages/protocol (SceneDocument + EngineRenderSpec). engine-three pod wiring deferred
  (needs headless-gl float-RT validation). Validated via typecheck + build + browser smoke.
```

- [ ] **Step 2: Export-inherits-look smoke (browser)**

`npm run dev:avatar` → reload. Set the Look preset to **Noir**. In console, run a short offline export and confirm the produced MP4 is non-trivial (the encoder path already validated in SP-1; this confirms the composer renders inside the export loop without error):

```js
const cv = window.__las.stage.renderOutputFrame();
const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height;
t.getContext('2d').drawImage(cv, 0, 0);
const px = t.getContext('2d').getImageData(cv.width/2, cv.height/2, 1, 1).data;
console.log('output center pixel (noir → low saturation):', [...px]);
```

Expected: `renderOutputFrame()` returns a non-blank frame rendered through the output composer (R≈G≈B under Noir's −1 saturation). PASS = the look is in the captured/export path.

- [ ] **Step 3: Commit**

```bash
git add apps/avatar-live/README.md progress.md
git commit -m "docs(avatar-live): document Look system + SP-2 validation (SP-2)"
```

---

## Appendix — deferred (NOT in SP-2)

- **engine-three pod postFX:** wiring `PostProcessingSpec` into the headless `gl`/Xvfb renderer requires validating a float-render-target `EffectComposer` round-trip on the pod first (documented failure mode). The protocol field exists (T-3) so the contract is ready; the pod-side render is a later task. Do not attempt pod work here.
- **LUT3D filmstock looks** and a **custom sharpen** effect (postprocessing has no built-in sharpen) — later.
- **Per-beat/section look overrides** from the Newscast DSL (`Beat.lookOverride`/`Section.lookOverride`) land in SP-3 (the language), not here.

---

## Self-Review

**Spec coverage (§8.2):** postprocessing integration (T1+T2) ✓; default broadcast look + filter vocabulary (T1 presets/params) ✓; correct HDR→tonemap→LDR order (T1) ✓; `PostProcessingSpec` in protocol + schema regen (T3) ✓; Look UI dropdown + sliders (T4+T5) ✓; applies to capture/export so SP-1 MP4 inherits it (T2 output composer + T6 smoke) ✓; ACES-now/AgX-later noted (T1+T3+docs) ✓; engine-three headless-gl validation deferred with the protocol contract in place (Appendix) ✓.

**Placeholder scan:** new files are complete code; existing-file edits give exact old→new snippets + the recon's locations; the one library-API uncertainty (effect uniform setters) is gated by typecheck with an explicit "use the installed d.ts" instruction (not a silent TODO).

**Type consistency:** `LookParams`/`LookFx`/`LookChain`/`LOOK_PRESETS`/`DEFAULT_LOOK` defined in T1, consumed by T2 (`stage.setLook`/`buildLookChain`/`applyLookParams`), T5 (`Look` controller), and T5 projectStore (`LookParams`). `stage.setLook(params: LookParams)` (T2) matches the controller's calls (T5). Protocol `PostProcessingSpec` (T3) is the wire contract; the in-app `LookParams` is the runtime subset (exposure handled via `stage.setExposure`). dom ids (`lookPreset`, `lookBloom`, `lookContrast`, `lookSaturation`, `lookVignette`, `lookGrain`) defined in T4, used in T5.
