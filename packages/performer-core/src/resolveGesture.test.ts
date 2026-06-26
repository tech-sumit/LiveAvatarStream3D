import { describe, it, expect } from 'vitest';
import { resolveGesture } from './resolveGesture.js';
import type { GestureKind } from './types.js';

// The camelCase→snake_case clip map performer-core duplicates from protocol's presets.ts.
// A protocol-side test (Phase 3) asserts the two tables are byte-equal; this pins the values
// here so a drift fails on BOTH sides.
const EXPECTED_CLIP: Record<GestureKind, string | null> = {
  none: null,
  explain: null,
  point: null,
  count: null,
  wave: 'wave',
  present: 'open_palms',
  openPalms: 'open_palms',
  thumbsUp: 'thumbs_up',
  shrug: 'shrug',
  handToChest: 'hand_to_chest',
  clasp: 'hand_to_chest',
  nod: 'nod',
};

describe('resolveGesture — pure kind → Drive mapping', () => {
  it('point/count resolve to IK drives (no library clip)', () => {
    expect(resolveGesture('point')).toMatchObject({ kind: 'ik', ik: 'aim' });
    expect(resolveGesture('count')).toMatchObject({ kind: 'ik', ik: 'count' });
  });

  it('library kinds resolve to their snake_case clip (the casing seam)', () => {
    for (const kind of Object.keys(EXPECTED_CLIP) as GestureKind[]) {
      const clip = EXPECTED_CLIP[kind];
      if (clip && kind !== 'point' && kind !== 'count') {
        expect(resolveGesture(kind)).toMatchObject({ kind: 'clip', clip });
      }
    }
  });

  it('none/explain resolve to a no-clip drive', () => {
    expect(resolveGesture('none')).toMatchObject({ kind: 'none' });
    expect(resolveGesture('explain')).toMatchObject({ kind: 'none' });
  });

  it('every result carries a deterministic baseEnergy (the rotation-counter fix)', () => {
    for (const kind of Object.keys(EXPECTED_CLIP) as GestureKind[]) {
      const d = resolveGesture(kind);
      expect(d.baseEnergy).toBeDefined();
      expect(['low', 'med', 'high']).toContain(d.baseEnergy);
    }
  });

  it('baseEnergy follows the intensity hint deterministically (low/med/high)', () => {
    expect(resolveGesture('wave', { amount: 0.1 }).baseEnergy).toBe('low');
    expect(resolveGesture('wave', { amount: 0.5 }).baseEnergy).toBe('med');
    expect(resolveGesture('wave', { amount: 0.9 }).baseEnergy).toBe('high');
    expect(resolveGesture('wave').baseEnergy).toBe('med'); // default
  });

  it('is pure: identical (kind, params) → deeply-equal Drive across repeated calls (no module state)', () => {
    for (const kind of Object.keys(EXPECTED_CLIP) as GestureKind[]) {
      const a = resolveGesture(kind, { amount: 0.7 });
      const b = resolveGesture(kind, { amount: 0.7 });
      expect(a).toEqual(b);
    }
    // interleaving different kinds must not perturb a repeated call (the gestures.ts rotation bug).
    const first = resolveGesture('wave');
    resolveGesture('nod');
    resolveGesture('point');
    expect(resolveGesture('wave')).toEqual(first);
  });
});
