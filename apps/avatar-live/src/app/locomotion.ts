import * as THREE from 'three';
import type { StudioContext } from './context.js';

// Realtime locomotion tuning.
const WALK_SPEED = 1.15; // m/s forward
const BACK_SPEED = 0.75; // m/s backward
const TURN_SPEED = 1.7; // rad/s
const BOUND = 6; // clamp the avatar to the stage floor

const _fwd = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Realtime arrow-key locomotion. Press **M** to toggle "walk mode"; while on,
 * the arrow keys drive the AVATAR instead of dollying the camera:
 *   ↑ walk forward · ↓ walk backward (both along the avatar's facing) · ← / → turn.
 * It plays the loaded walk/turn clips (loaded by AvatarLibrary via
 * `avatar.loadLocomotion`) and moves the avatar's group; the camera stays put
 * (orbit/zoom to follow). Releasing the keys settles the avatar back to idle.
 */
export class Locomotion {
  private keys = new Set<string>();
  private active = false;
  private heading = 0; // avatar facing (radians, group.rotation.y)
  constructor(private app: StudioContext) {}

  get isActive(): boolean {
    return this.active;
  }

  init(): void {
    // Capture phase so we can block the camera-dolly arrow handler while walking.
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    this.app.stage.onFrame((dt) => this.tick(dt));
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e)) return;
    if (e.key === 'm' || e.key === 'M') {
      this.toggle();
      return;
    }
    if (this.active && e.key.startsWith('Arrow')) {
      this.keys.add(e.key);
      e.preventDefault();
      e.stopImmediatePropagation(); // don't also dolly the camera
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.keys.delete(e.key) && this.active) e.stopImmediatePropagation();
  };

  toggle(): void {
    this.active = !this.active;
    if (this.active) {
      this.heading = this.app.avatar.group.rotation.y;
      const have = this.app.avatar.locomotionClips.length;
      this.app.log(
        have
          ? '🚶 walk mode ON — ↑/↓ walk, ←/→ turn (M to exit)'
          : 'walk mode ON, but no walk clips loaded — run scripts/fetch + convert the walk FBX.',
      );
    } else {
      this.keys.clear();
      this.app.avatar.stopLocomotion();
      this.app.log('walk mode OFF');
    }
  }

  private tick(dt: number): void {
    if (!this.active) return;
    const { avatar } = this.app;
    const up = this.keys.has('ArrowUp');
    const down = this.keys.has('ArrowDown');
    const left = this.keys.has('ArrowLeft');
    const right = this.keys.has('ArrowRight');

    // Turn (change facing).
    if (left) this.heading += TURN_SPEED * dt;
    if (right) this.heading -= TURN_SPEED * dt;
    avatar.group.rotation.y = this.heading;

    // Move along the facing.
    const fwd = _fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const pos = avatar.group.position;
    if (up) pos.addScaledVector(fwd, WALK_SPEED * dt);
    else if (down) pos.addScaledVector(fwd, -BACK_SPEED * dt);
    pos.x = THREE.MathUtils.clamp(pos.x, -BOUND, BOUND);
    pos.z = THREE.MathUtils.clamp(pos.z, -BOUND, BOUND);

    // Pick the clip that matches what's happening.
    if (up) avatar.playLocomotion('walk');
    else if (down) avatar.playLocomotion('walk_back');
    else if (left || right) avatar.playLocomotion('walk'); // legs shuffle while turning
    else avatar.stopLocomotion();

    // Keep the avatar in view while it's actually moving: gently pan the camera
    // target to follow (the camera position stays; orbit/zoom still work).
    if (up || down || left || right) {
      this.app.stage.controls.target.lerp(_look.set(pos.x, 1.5, pos.z), 0.07);
    }
  }
}
