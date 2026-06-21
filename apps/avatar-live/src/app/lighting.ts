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
  studio: { key: 1.6, fill: 0.35, rim: 0.6, amb: 0.45, exp: 1.05, warm: 55 },
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
    const { studio, avatar, dom } = this.app;
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
    this.studioOn = doc.studioOn ?? true;
    studio.group.visible = this.studioOn;
    dom.studioToggle.textContent = `Studio: ${this.studioOn ? 'On' : 'Off'}`;
    dom.studioToggle.classList.toggle('primary', this.studioOn);
    this.idleMotionOn = doc.idleMotion ?? false;
    avatar.setIdleMotion(this.idleMotionOn);
    dom.idleMotionToggle.textContent = `Idle motion: ${this.idleMotionOn ? 'On' : 'Off'}`;
    dom.idleMotionToggle.classList.toggle('primary', this.idleMotionOn);
    if (doc.headline) {
      dom.headlineInput.value = doc.headline;
      studio.setHeadline(doc.headline);
    }
  }

  init(): void {
    const { studio, avatar, dom, log } = this.app;
    dom.studioToggle.addEventListener('click', () => {
      this.studioOn = !this.studioOn;
      studio.group.visible = this.studioOn;
      dom.studioToggle.textContent = `Studio: ${this.studioOn ? 'On' : 'Off'}`;
      dom.studioToggle.classList.toggle('primary', this.studioOn);
    });
    dom.headlineInput.addEventListener('input', () => {
      const v = dom.headlineInput.value.trim();
      if (v) studio.setHeadline(v);
    });
    avatar.setIdleMotion(false);
    dom.idleMotionToggle.addEventListener('click', () => {
      this.idleMotionOn = !this.idleMotionOn;
      avatar.setIdleMotion(this.idleMotionOn);
      dom.idleMotionToggle.textContent = `Idle motion: ${this.idleMotionOn ? 'On' : 'Off'}`;
      dom.idleMotionToggle.classList.toggle('primary', this.idleMotionOn);
    });
    [dom.lightKey, dom.lightFill, dom.lightRim, dom.lightAmbient, dom.exposureEl, dom.warmthEl].forEach((el) =>
      el.addEventListener('input', this.applyLights),
    );
    dom.lightPresetSel.addEventListener('change', () => {
      const p = LIGHT_PRESETS[dom.lightPresetSel.value];
      if (!p) return;
      dom.lightKey.value = String(p.key);
      dom.lightFill.value = String(p.fill);
      dom.lightRim.value = String(p.rim);
      dom.lightAmbient.value = String(p.amb);
      dom.exposureEl.value = String(p.exp);
      dom.warmthEl.value = String(p.warm);
      this.applyLights();
      log(`light preset: ${dom.lightPresetSel.value}`);
    });
    this.applyLights();
  }
}
