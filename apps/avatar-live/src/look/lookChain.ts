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
