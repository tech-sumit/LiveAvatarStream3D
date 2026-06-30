import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { poseFor, poseForShotId, type CameraPose } from './catalog.js';

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
