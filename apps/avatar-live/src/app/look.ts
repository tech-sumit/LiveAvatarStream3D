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
