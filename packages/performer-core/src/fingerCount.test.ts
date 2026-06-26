import { describe, it, expect } from 'vitest';
import { fingerCount } from './fingerCount.js';
import type { FingerCurls } from './types.js';
import { FINGER_COUNT_1, FINGER_COUNT_2, FINGER_COUNT_3 } from './__fixtures__/regression.js';

function expectCurls(actual: number[][], expected: number[][]): void {
  expect(actual.length).toBe(expected.length);
  for (let f = 0; f < expected.length; f++) {
    const a = actual[f];
    const e = expected[f];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    expect(a!.length).toBe(e!.length);
    for (let j = 0; j < e!.length; j++) {
      expect(a![j]).toBeCloseTo(e![j]!, 10);
    }
  }
}

// Pins applyCounting's FINGER_CURL [-1.0,-1.45,-1.2] + COUNT_PHASE 0.75 ramp for n=1,2,3.
describe('fingerCount — regression parity with applyCounting', () => {
  it('shows 1 finger before the first phase (t < 0.75)', () => {
    const r = fingerCount(FINGER_COUNT_1.input.n, FINGER_COUNT_1.input.t);
    expectCurls(r.curls, FINGER_COUNT_1.expected);
  });

  it('shows 2 fingers in the second phase (0.75 ≤ t < 1.5)', () => {
    const r = fingerCount(FINGER_COUNT_2.input.n, FINGER_COUNT_2.input.t);
    expectCurls(r.curls, FINGER_COUNT_2.expected);
  });

  it('shows 3 fingers from the third phase on (t ≥ 1.5)', () => {
    const r = fingerCount(FINGER_COUNT_3.input.n, FINGER_COUNT_3.input.t);
    expectCurls(r.curls, FINGER_COUNT_3.expected);
  });

  it('caps the displayed count at the requested n (count to 2 never reaches 3)', () => {
    const r = fingerCount(2, 5.0); // t well past 2·phase, but n = 2
    // middle finger (index 1) extended (0), ring (index 2) still folded.
    expect(r.curls[1]![0]).toBeCloseTo(0, 10);
    expect(r.curls[2]![0]).toBeCloseTo(-1.0, 10); // FINGER_CURL[0]
  });

  it('out-param call writes into the supplied FingerCurls and matches the allocating call', () => {
    const alloc = fingerCount(3, 0.0);
    const out: FingerCurls = { curls: [] };
    const written = fingerCount(3, 0.0, undefined, out);
    expect(written).toBe(out);
    expectCurls(out.curls, alloc.curls);
  });
});
