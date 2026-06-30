import { describe, it, expect } from 'vitest';
import { composeShot } from './composeShot.js';
import { CAMERA_SHOTS, CAMERA_SHOT_IDS, sampleShot } from './cameraShots.js';
import type { Subject } from './types.js';

const anchor: Subject = { pos: [0, 1.53, 0], size: 0.42 };
const screen: Subject = { pos: [1.95, 1.62, -0.35], size: 1.0 };
const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('composeShot — orbit / roll / numeric size extensions', () => {
  it('azimuth = 0, elevation = 0, roll = 0 is identical to no orbit (parity preserved)', () => {
    const base = composeShot([anchor], { size: 'medium' });
    const orbit0 = composeShot([anchor], { size: 'medium', azimuth: 0, elevation: 0, roll: 0 });
    expect(orbit0.pos[0]).toBeCloseTo(base.pos[0], 10);
    expect(orbit0.pos[1]).toBeCloseTo(base.pos[1], 10);
    expect(orbit0.pos[2]).toBeCloseTo(base.pos[2], 10);
    expect(orbit0.roll ?? 0).toBe(0);
  });

  it('azimuth orbits the camera around the target, preserving the camera→target distance', () => {
    const base = composeShot([anchor], { size: 'cu' });
    const orbited = composeShot([anchor], { size: 'cu', azimuth: 90 });
    const dBase = dist(base.pos, base.target);
    const dOrbit = dist(orbited.pos, orbited.target);
    expect(dOrbit).toBeCloseTo(dBase, 6); // radius preserved
    // +90° from head-on (+Z) lands the camera on the +X side (the anchor's right / screen side)
    expect(orbited.pos[0]).toBeGreaterThan(base.pos[0] + 0.5);
    expect(orbited.pos[2]).toBeCloseTo(orbited.target[2], 3); // swung onto the target's Z plane
  });

  it('positive elevation raises the camera (looking down); negative lowers it (looking up)', () => {
    const base = composeShot([anchor], { size: 'medium' });
    const high = composeShot([anchor], { size: 'medium', elevation: 20 });
    const low = composeShot([anchor], { size: 'medium', elevation: -20 });
    expect(high.pos[1]).toBeGreaterThan(base.pos[1]);
    expect(low.pos[1]).toBeLessThan(base.pos[1]);
    // distance to target preserved by the spherical orbit
    expect(dist(high.pos, high.target)).toBeCloseTo(dist(base.pos, base.target), 6);
  });

  it('roll is carried onto the Pose (dutch tilt) without moving the camera', () => {
    const base = composeShot([anchor], { size: 'medium' });
    const rolled = composeShot([anchor], { size: 'medium', roll: 6 });
    expect(rolled.roll).toBe(6);
    expect(rolled.pos[0]).toBeCloseTo(base.pos[0], 10); // roll never moves the camera
    expect(rolled.pos[2]).toBeCloseTo(base.pos[2], 10);
  });

  it('numeric size is monotonic — a larger head-height count sits the camera farther back', () => {
    const tight = composeShot([anchor], { size: 4.2 });
    const loose = composeShot([anchor], { size: 7.0 });
    expect(loose.pos[2]).toBeGreaterThan(tight.pos[2]); // farther on +Z
    expect(dist(loose.pos, loose.target)).toBeGreaterThan(dist(tight.pos, tight.target));
  });
});

describe('cameraShots catalog + sampleShot', () => {
  it('every catalog id resolves to a valid pose for its subjects', () => {
    for (const id of CAMERA_SHOT_IDS) {
      const preset = CAMERA_SHOTS[id];
      expect(preset, `missing preset ${id}`).toBeTruthy();
      const subjects: Subject[] = preset.subject === 'both' ? [anchor, screen] : preset.subject === 'screen' ? [screen] : [anchor];
      const pose = sampleShot(preset, subjects, 0);
      for (const n of [...pose.pos, ...pose.target, pose.fov]) expect(Number.isFinite(n)).toBe(true);
      expect(pose.fov).toBeGreaterThan(0);
    }
  });

  it('CAMERA_SHOT_IDS and CAMERA_SHOTS agree (no orphan ids or entries)', () => {
    expect([...CAMERA_SHOT_IDS].sort()).toEqual(Object.keys(CAMERA_SHOTS).sort());
    expect(CAMERA_SHOT_IDS.length).toBeGreaterThanOrEqual(10);
  });

  it('dutch preset carries a non-zero roll', () => {
    const pose = sampleShot(CAMERA_SHOTS['dutch'], [anchor], 0);
    expect(pose.roll).toBeGreaterThan(0);
  });

  it('push-in dollies in over its duration (start wider than end, midpoint between)', () => {
    const preset = CAMERA_SHOTS['push-in'];
    const start = sampleShot(preset, [anchor], 0);
    const mid = sampleShot(preset, [anchor], (preset.move!.durationSec) / 2);
    const end = sampleShot(preset, [anchor], preset.move!.durationSec);
    const dStart = dist(start.pos, start.target);
    const dMid = dist(mid.pos, mid.target);
    const dEnd = dist(end.pos, end.target);
    expect(dStart).toBeGreaterThan(dEnd); // ends tighter
    expect(dMid).toBeLessThan(dStart);
    expect(dMid).toBeGreaterThan(dEnd);
  });

  it('push-in clamps past its duration (holds the final framing)', () => {
    const preset = CAMERA_SHOTS['push-in'];
    const end = sampleShot(preset, [anchor], preset.move!.durationSec);
    const past = sampleShot(preset, [anchor], preset.move!.durationSec * 3);
    expect(dist(past.pos, past.target)).toBeCloseTo(dist(end.pos, end.target), 6);
  });
});
