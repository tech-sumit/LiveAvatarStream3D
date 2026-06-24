import type { StudioContext } from './context.js';

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

const LIGHT_PRESETS: Record<string, { key: number; fill: number; rim: number; amb: number; exp: number; warm: number }> = {
  studio: { key: 2.6, fill: 1.0, rim: 0.8, amb: 0.95, exp: 1.15, warm: 55 },
  soft: { key: 1.0, fill: 0.9, rim: 0.3, amb: 0.85, exp: 1.1, warm: 50 },
  dramatic: { key: 2.6, fill: 0.08, rim: 1.3, amb: 0.12, exp: 1.0, warm: 48 },
  warm: { key: 1.8, fill: 0.4, rim: 0.5, amb: 0.5, exp: 1.05, warm: 82 },
  cool: { key: 1.6, fill: 0.4, rim: 0.7, amb: 0.5, exp: 1.0, warm: 18 },
};

/** News-studio visibility, three-point lighting + presets, and idle motion. */
export class Lighting {
  private studioOn = true;
  private idleMotionOn = false;
  constructor(private app: StudioContext) {}

  private applyLights = (): void => {
    const { stage, dom } = this.app;
    stage.setLightIntensity('key', Number(dom.lightKey.value));
    stage.setLightIntensity('fill', Number(dom.lightFill.value));
    stage.setLightIntensity('rim', Number(dom.lightRim.value));
    stage.setLightIntensity('ambient', Number(dom.lightAmbient.value));
    stage.setExposure(Number(dom.exposureEl.value));
    // Warmth 0 (cool blue) → 100 (warm amber) on the key light.
    stage.setLightColor('key', mixColor(0xcfe0ff, 0xffcf8e, Number(dom.warmthEl.value) / 100));
  };

  private setStudioOn(on: boolean): void {
    this.studioOn = on;
    this.app.studio.group.visible = on;
    this.app.dom.studioToggle.textContent = `Studio: ${on ? 'On' : 'Off'}`;
    this.app.dom.studioToggle.classList.toggle('primary', on);
  }
  private setIdleMotion(on: boolean): void {
    this.idleMotionOn = on;
    this.app.avatar.setIdleMotion(on);
    this.app.dom.idleMotionToggle.textContent = `Idle motion: ${on ? 'On' : 'Off'}`;
    this.app.dom.idleMotionToggle.classList.toggle('primary', on);
  }

  serialize() {
    const d = this.app.dom;
    return {
      studioOn: this.studioOn,
      idleMotion: this.idleMotionOn,
      headline: d.headlineInput.value,
      lights: {
        key: Number(d.lightKey.value),
        fill: Number(d.lightFill.value),
        rim: Number(d.lightRim.value),
        ambient: Number(d.lightAmbient.value),
        exposure: Number(d.exposureEl.value),
        warmth: Number(d.warmthEl.value),
        preset: d.lightPresetSel.value,
      },
    };
  }

  apply(doc: {
    studioOn?: boolean;
    idleMotion?: boolean;
    headline?: string;
    lights?: { key: number; fill: number; rim: number; ambient: number; exposure: number; warmth: number; preset: string };
  }): void {
    const { studio, dom } = this.app;
    if (doc.lights) {
      dom.lightKey.value = String(doc.lights.key);
      dom.lightFill.value = String(doc.lights.fill);
      dom.lightRim.value = String(doc.lights.rim);
      dom.lightAmbient.value = String(doc.lights.ambient);
      dom.exposureEl.value = String(doc.lights.exposure);
      dom.warmthEl.value = String(doc.lights.warmth);
      dom.lightPresetSel.value = doc.lights.preset ?? 'studio';
      this.applyLights();
    }
    this.setStudioOn(doc.studioOn ?? true);
    this.setIdleMotion(doc.idleMotion ?? false);
    if (doc.headline) {
      dom.headlineInput.value = doc.headline;
      studio.setHeadline(doc.headline);
    }
  }

  /** Push the named preset's values into the sliders and apply them. */
  private applyPreset(name: string): void {
    const { dom, log } = this.app;
    const p = LIGHT_PRESETS[name];
    if (!p) return;
    dom.lightKey.value = String(p.key);
    dom.lightFill.value = String(p.fill);
    dom.lightRim.value = String(p.rim);
    dom.lightAmbient.value = String(p.amb);
    dom.exposureEl.value = String(p.exp);
    dom.warmthEl.value = String(p.warm);
    this.applyLights();
    this.syncReadouts();
    log(`light preset: ${name}`);
  }

  /** Re-apply the currently selected lighting preset (Reset button). */
  resetToPreset = (): void => this.applyPreset(this.app.dom.lightPresetSel.value);

  // Programmatic slider changes don't fire `input`, so nudge the readouts to refresh.
  private syncReadouts(): void {
    [this.app.dom.lightKey, this.app.dom.lightFill, this.app.dom.lightRim, this.app.dom.lightAmbient, this.app.dom.exposureEl, this.app.dom.warmthEl].forEach(
      (el) => el.dispatchEvent(new Event('input', { bubbles: true })),
    );
  }

  init(): void {
    const { studio, dom } = this.app;
    dom.studioToggle.addEventListener('click', () => this.setStudioOn(!this.studioOn));
    dom.headlineInput.addEventListener('input', () => {
      const v = dom.headlineInput.value.trim();
      if (v) studio.setHeadline(v);
    });
    this.setIdleMotion(false);
    dom.idleMotionToggle.addEventListener('click', () => this.setIdleMotion(!this.idleMotionOn));
    [dom.lightKey, dom.lightFill, dom.lightRim, dom.lightAmbient, dom.exposureEl, dom.warmthEl].forEach((el) =>
      el.addEventListener('input', this.applyLights),
    );
    dom.lightPresetSel.addEventListener('change', () => this.applyPreset(dom.lightPresetSel.value));
    dom.lightReset.addEventListener('click', this.resetToPreset);
    this.applyLights();
  }
}
