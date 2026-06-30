import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { StudioContext } from './context.js';
import { applyShot, populateShotDropdown } from './shotPresets.js';

/** Camera framing, align-to-face (+ auto-align), and the move/rotate gizmo. */
export class AvatarTransform {
  private autoAlignOn = false;
  private gizmoOn = false;
  private gizmoProxy = new THREE.Object3D();
  private chestY = 1.15;
  private gizmo: TransformControls;

  constructor(private app: StudioContext) {
    app.stage.add(this.gizmoProxy);
    this.gizmo = new TransformControls(app.stage.camera, app.stage.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setSize(2.0);
    this.gizmo.attach(this.gizmoProxy);
    this.gizmo.visible = false;
    this.gizmo.enabled = false;
    app.stage.add(this.gizmo);
    app.stage.excludeFromCapture(this.gizmo); // never in the recorded output
    this.gizmo.addEventListener('dragging-changed', (e) => {
      app.stage.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.gizmo.addEventListener('objectChange', () => {
      app.avatar.setPosition(this.gizmoProxy.position.x, this.gizmoProxy.position.y - this.chestY, this.gizmoProxy.position.z);
      app.avatar.group.quaternion.copy(this.gizmoProxy.quaternion);
      // The hand-placed spot becomes the anchor's home, so walk-to-screen returns here.
      app.avatar.setStageHome(app.avatar.group.position);
    });
  }

  /** World-space face center (head center offset by the avatar's position). */
  faceWorld(): THREE.Vector3 {
    return this.app.avatar.headCenter.clone().add(this.app.avatar.group.position);
  }
  get isAutoAlign(): boolean {
    return this.autoAlignOn;
  }
  get isGizmoOn(): boolean {
    return this.gizmoOn;
  }

  private syncGizmoToAvatar(): void {
    const av = this.app.avatar;
    this.chestY = Math.max(0.5, av.headCenter.y - 0.45);
    this.gizmoProxy.position.set(av.group.position.x, av.group.position.y + this.chestY, av.group.position.z);
    this.gizmoProxy.quaternion.copy(av.group.quaternion);
  }
  private setGizmoMode(mode: 'translate' | 'rotate'): void {
    const d = this.app.dom;
    this.gizmo.setMode(mode);
    this.gizmo.showX = this.gizmo.showZ = mode === 'translate';
    this.gizmo.showY = true; // rotate = Y-turn only; translate = all axes
    d.moveModeBtn.classList.toggle('primary', mode === 'translate');
    d.rotateModeBtn.classList.toggle('primary', mode === 'rotate');
  }
  private setGizmoOn(on: boolean): void {
    const { dom } = this.app;
    if (on) {
      this.syncGizmoToAvatar();
      dom.shotSel.value = 'wide';
      applyShot(this.app, 'wide'); // reveal the avatar + gizmo
      this.flashGate();
    }
    this.gizmo.visible = on;
    this.gizmo.enabled = on;
    dom.gizmoBtn.classList.toggle('primary', on);
    dom.gizmoModesEl.hidden = !on;
    // Drive viewport discoverability: the "Press G to edit" hint shows only while
    // the gizmo is OFF (class on #stage, hint is pointer-events:none / CSS-driven).
    dom.stageEl.classList.toggle('gizmo-on', on);
  }

  /** Briefly pulse the capture-gate border so a reframe/reset is noticeable. */
  private flashGate(): void {
    const gate = this.app.dom.cameraGateEl;
    if (!gate) return;
    gate.classList.remove('flash');
    void gate.offsetWidth; // restart the animation
    gate.classList.add('flash');
    window.setTimeout(() => gate.classList.remove('flash'), 320);
  }

  init(): void {
    const { stage, avatar, dom } = this.app;
    // Start with the gizmo-off hint visible (no class on #stage means "gizmo off").
    dom.stageEl.classList.remove('gizmo-on');
    // Expose the full shot-preset catalog in the #shot dropdown (one shared source with the
    // newscast cam cues). Preserves the current selection / defaults to medium.
    populateShotDropdown(dom.shotSel);
    dom.alignFaceBtn.addEventListener('click', () => {
      stage.alignToFace(this.faceWorld());
      this.flashGate();
    });
    dom.autoAlignBtn.addEventListener('click', () => {
      this.autoAlignOn = !this.autoAlignOn;
      dom.autoAlignBtn.textContent = `Auto-align: ${this.autoAlignOn ? 'On' : 'Off'}`;
      dom.autoAlignBtn.classList.toggle('primary', this.autoAlignOn);
      // Viewport feedback: glow the capture gate while auto-align tracks the face.
      dom.cameraGateEl?.classList.toggle('auto-aligning', this.autoAlignOn);
      if (this.autoAlignOn) stage.alignToFace(this.faceWorld()); // snap immediately, then keep aligned
    });
    dom.resetViewBtn.addEventListener('click', () => {
      applyShot(this.app, dom.shotSel.value);
      this.flashGate();
    });
    dom.centerAvatarBtn.addEventListener('click', () => {
      avatar.setPosition(0, 0, 0);
      avatar.group.quaternion.identity();
      this.syncGizmoToAvatar();
    });
    dom.shotSel.addEventListener('change', () => {
      applyShot(this.app, dom.shotSel.value);
      this.flashGate();
    });

    this.setGizmoMode('translate');
    dom.gizmoBtn.addEventListener('click', () => {
      this.gizmoOn = !this.gizmoOn;
      this.setGizmoOn(this.gizmoOn);
    });
    dom.moveModeBtn.addEventListener('click', () => this.setGizmoMode('translate'));
    dom.rotateModeBtn.addEventListener('click', () => this.setGizmoMode('rotate'));
    // Unity-style hotkeys: W = move, E = rotate, G = toggle gizmo, Esc = hide.
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'g' || e.key === 'G') {
        this.gizmoOn = !this.gizmoOn;
        this.setGizmoOn(this.gizmoOn);
      } else if (e.key === 'Escape') {
        this.gizmoOn = false;
        this.setGizmoOn(false);
      } else if (this.gizmoOn && (e.key === 'w' || e.key === 'W')) {
        this.setGizmoMode('translate');
      } else if (this.gizmoOn && (e.key === 'e' || e.key === 'E')) {
        this.setGizmoMode('rotate');
      }
    });
  }
}
