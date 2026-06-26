import { describe, it, expect } from 'vitest';
import { moveCamera } from './moveCamera.js';
import { composeShot } from './composeShot.js';
import type { CameraMove, Pose, Subject, Vec3 } from './types.js';

// ── Allocation-free out-param contract (cross-cutting rule C) ──────────────────────────
// moveCamera/composeShot are invoked per-frame with a reused `out` Pose (coreAdapter.ts).
// When `out` is supplied they must write components IN PLACE — the returned Pose, plus its
// `pos`/`target` Vec3 arrays, must be the exact instances passed in (no new object/array
// allocated). These tests fail if either function ever re-introduces a writePose that swaps
// in fresh arrays or returns a new Pose on the out-param path.

const BASE: Pose = { pos: [2, 1.5, 5], target: [0, 1.5, 0], fov: 35 };
const MOVES: CameraMove[] = ['truck', 'pedestal', 'dolly', 'pan', 'orbit'];

function freshOut(): Pose {
  return { pos: [0, 0, 0], target: [0, 0, 0], fov: 0 };
}

describe('moveCamera — out-param is allocation-free (writes in place)', () => {
  for (const move of MOVES) {
    it(`${move}: returns the same Pose + the same pos/target arrays (no new alloc)`, () => {
      const out = freshOut();
      const posRef = out.pos;
      const targetRef = out.target;

      const r = moveCamera(BASE, move, 0.4, out);

      // The returned object IS the supplied out — no new Pose object allocated.
      expect(r).toBe(out);
      // pos/target were written in place — same array instances, not replaced.
      expect(r.pos).toBe(posRef);
      expect(r.target).toBe(targetRef);

      // Sanity: the in-place write reproduces the allocating call exactly.
      const alloc = moveCamera(BASE, move, 0.4);
      expect(out.pos[0]).toBeCloseTo(alloc.pos[0], 12);
      expect(out.pos[1]).toBeCloseTo(alloc.pos[1], 12);
      expect(out.pos[2]).toBeCloseTo(alloc.pos[2], 12);
      expect(out.target[0]).toBeCloseTo(alloc.target[0], 12);
      expect(out.target[1]).toBeCloseTo(alloc.target[1], 12);
      expect(out.target[2]).toBeCloseTo(alloc.target[2], 12);
      expect(out.fov).toBe(alloc.fov);
    });
  }

  it('no-out call still allocates a fresh Pose with fresh arrays', () => {
    const a = moveCamera(BASE, 'orbit', 0.4);
    const b = moveCamera(BASE, 'orbit', 0.4);
    expect(a).not.toBe(b);
    expect(a.pos).not.toBe(b.pos);
    expect(a.target).not.toBe(b.target);
    // And it must never alias the input base arrays.
    expect(a.pos).not.toBe(BASE.pos);
    expect(a.target).not.toBe(BASE.target);
  });
});

describe('composeShot — out-param is allocation-free (writes in place)', () => {
  const single: Subject[] = [{ pos: [0, 1.53, 0] as Vec3, size: 0.42 }];
  const twoShot: Subject[] = [
    { pos: [-1, 1.5, 0] as Vec3 },
    { pos: [1.5, 1.5, -0.5] as Vec3 },
  ];

  it('single-subject branch: same Pose + same pos/target arrays (no new alloc)', () => {
    const out = freshOut();
    const posRef = out.pos;
    const targetRef = out.target;

    const r = composeShot(single, { size: 'cu', balance: 0.3, height: 0.2 }, out);

    expect(r).toBe(out);
    expect(r.pos).toBe(posRef);
    expect(r.target).toBe(targetRef);

    const alloc = composeShot(single, { size: 'cu', balance: 0.3, height: 0.2 });
    expect(out.pos[0]).toBeCloseTo(alloc.pos[0], 12);
    expect(out.pos[1]).toBeCloseTo(alloc.pos[1], 12);
    expect(out.pos[2]).toBeCloseTo(alloc.pos[2], 12);
    expect(out.target[0]).toBeCloseTo(alloc.target[0], 12);
    expect(out.target[1]).toBeCloseTo(alloc.target[1], 12);
    expect(out.target[2]).toBeCloseTo(alloc.target[2], 12);
    expect(out.fov).toBe(alloc.fov);
  });

  it('two-shot branch: same Pose + same pos/target arrays (no new alloc)', () => {
    const out = freshOut();
    const posRef = out.pos;
    const targetRef = out.target;

    const r = composeShot(twoShot, { follow: true }, out);

    expect(r).toBe(out);
    expect(r.pos).toBe(posRef);
    expect(r.target).toBe(targetRef);

    const alloc = composeShot(twoShot, { follow: true });
    expect(out.pos[0]).toBeCloseTo(alloc.pos[0], 12);
    expect(out.pos[1]).toBeCloseTo(alloc.pos[1], 12);
    expect(out.pos[2]).toBeCloseTo(alloc.pos[2], 12);
    expect(out.target[0]).toBeCloseTo(alloc.target[0], 12);
    expect(out.target[1]).toBeCloseTo(alloc.target[1], 12);
    expect(out.target[2]).toBeCloseTo(alloc.target[2], 12);
    expect(out.fov).toBe(alloc.fov);
  });

  it('no-out call still allocates a fresh Pose with fresh arrays', () => {
    const a = composeShot(single, { size: 'cu' });
    const b = composeShot(single, { size: 'cu' });
    expect(a).not.toBe(b);
    expect(a.pos).not.toBe(b.pos);
    expect(a.target).not.toBe(b.target);
  });
});
