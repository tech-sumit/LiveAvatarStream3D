import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyMotion, CATALOG, poseFor, poseForShotId, type CameraPose } from './catalog.js';
import { SCREEN_TURN } from './motionCues.js';
import type { AvatarController } from '../avatar/avatarController.js';

// Regression: the dutch shot preset is the only framing that carries a non-zero roll. Because
// poseFor writes into a REUSED CameraPose buffer (TimelinePlayer holds _poseFrom/_poseTo across
// frames), a dutch resolution must not leak its roll onto the next, level cue resolved into the
// same buffer. Guards the apply-layer roll reset in poseFor / poseForShotId.
describe('poseFor — dutch roll does not leak through a reused buffer', () => {
  const hc = new THREE.Vector3(0, 1.53, 0);
  const hh = 0.42;
  const buf: CameraPose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0, roll: 0 };

  it('cam.dutch carries roll; a following angled cue (cam.orbit) into the same buffer resets to 0', () => {
    poseFor('cam.dutch', hc, hh, buf);
    expect(buf.roll).toBeGreaterThan(0); // dutch is canted

    poseFor('cam.orbit', hc, hh, buf); // legacy angled framing — must be level
    expect(buf.roll).toBe(0);
  });

  it('a size-preset cue (cam.anchor) after dutch is also level', () => {
    poseForShotId('dutch', hc, hh, 0, buf);
    expect(buf.roll).toBeGreaterThan(0);

    poseFor('cam.anchor', hc, hh, buf);
    expect(buf.roll).toBe(0);
  });

  it('a non-dutch preset (profile) resolves with roll 0', () => {
    poseForShotId('dutch', hc, hh, 0, buf); // dirty the buffer
    poseForShotId('profile', hc, hh, 0, buf);
    expect(buf.roll).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// poseFor characterization — every framing cue type in the CATALOG must resolve
// to a finite, usable camera pose around any anchor head. This is the timeline
// player's whole camera surface; a NaN here renders a black frame with no error.
// ─────────────────────────────────────────────────────────────────────────────
describe('poseFor — every framing cue type resolves to a finite pose', () => {
  const hc = new THREE.Vector3(0, 1.53, 0);
  const hh = 0.42;

  // The camera cue types that carry a preset framing. cam.custom / cam.path carry
  // authored poses and cam.screenSource is a vision-mixer cut — none resolve here.
  const FRAMING_TYPES = Object.keys(CATALOG).filter(
    (k) => CATALOG[k]!.track === 'camera' && !['cam.custom', 'cam.path', 'cam.screenSource'].includes(k),
  );

  it('the framing cue set is the pinned 12 (6 legacy + 6 catalog presets)', () => {
    expect(FRAMING_TYPES).toEqual([
      'cam.enterLeft',
      'cam.wide',
      'cam.anchor',
      'cam.close',
      'cam.screen',
      'cam.orbit',
      'cam.otsScreen',
      'cam.profile',
      'cam.heroLow',
      'cam.dutch',
      'cam.establish',
      'cam.pushIn',
    ]);
  });

  for (const type of FRAMING_TYPES) {
    it(`${type} → finite pos/target, positive fov, finite roll`, () => {
      const p = poseFor(type, hc, hh);
      for (const v of [p.pos.x, p.pos.y, p.pos.z, p.target.x, p.target.y, p.target.z]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(p.fov).toBeGreaterThan(0);
      expect(Number.isFinite(p.roll ?? 0)).toBe(true);
      // pos ≠ target — a degenerate look-at direction would break the camera basis.
      expect(p.pos.distanceTo(p.target)).toBeGreaterThan(0.01);
    });
  }

  it('the close-up sits nearer the head than the wide', () => {
    const close = poseFor('cam.close', hc, hh);
    const wide = poseFor('cam.wide', hc, hh);
    expect(close.pos.distanceTo(hc)).toBeLessThan(wide.pos.distanceTo(hc));
  });

  it('writes into a supplied `out` buffer and returns the SAME object (allocation-free)', () => {
    const buf: CameraPose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 0 };
    const r = poseFor('cam.anchor', hc, hh, buf);
    expect(r).toBe(buf);
    expect(buf.fov).toBeGreaterThan(0);
  });

  it('an unknown cue type falls back to the medium (cam.anchor) framing, not an error', () => {
    // NOTE: pinned fallback — compositionFor's default branch is `medium`, so a typo'd
    // cam.* cue silently frames like cam.anchor instead of throwing.
    const bogus = poseFor('cam.does_not_exist', hc, hh);
    const anchor = poseFor('cam.anchor', hc, hh);
    expect(bogus.pos.toArray()).toEqual(anchor.pos.toArray());
    expect(bogus.target.toArray()).toEqual(anchor.target.toArray());
    expect(bogus.fov).toBe(anchor.fov);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyMotion characterization — motion cues fire once at cue start: an optional
// setTurn (from the shared motionCues vocabulary) plus a returned talk-clip name
// (or null). Pinned so preview staging can't drift under refactors.
// ─────────────────────────────────────────────────────────────────────────────
describe('applyMotion — turn + clip per motion cue type', () => {
  function recordingAvatar() {
    const turns: number[] = [];
    const avatar = { setTurn: (yaw: number) => void turns.push(yaw) } as unknown as AvatarController;
    return { avatar, turns };
  }

  it('motion.turnScreen turns to the screen and plays no clip', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.turnScreen', avatar)).toBeNull();
    expect(turns).toEqual([SCREEN_TURN]);
  });

  it('motion.faceFront turns to yaw 0 and plays no clip', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.faceFront', avatar)).toBeNull();
    expect(turns).toEqual([0]);
  });

  it('motion.point turns 70% toward the screen and plays talk3', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.point', avatar)).toBe('talk3');
    expect(turns).toEqual([SCREEN_TURN * 0.7]);
  });

  it('motion.wave plays talk5 without touching the turn', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.wave', avatar)).toBe('talk5');
    expect(turns).toEqual([]); // undefined yaw ⇒ setTurn NOT called
  });

  it('motion.nod plays idle_calm without touching the turn', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.nod', avatar)).toBe('idle_calm');
    expect(turns).toEqual([]);
  });

  it('motion.explain plays talk1 without touching the turn', () => {
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.explain', avatar)).toBe('talk1');
    expect(turns).toEqual([]);
  });

  it('an unknown motion type plays nothing (no clip, no turn)', () => {
    // A typo'd motion cue used to silently play the generic explain clip, hiding the
    // authoring mistake — it now returns null (motionCueTurn already ignored unknowns).
    const { avatar, turns } = recordingAvatar();
    expect(applyMotion('motion.bogus', avatar)).toBeNull();
    expect(turns).toEqual([]);
  });
});
