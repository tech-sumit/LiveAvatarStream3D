import { describe, it, expect } from 'vitest';
import { planPath } from './planPath.js';
import { PATH_CASE, STATION_SPEED } from './__fixtures__/regression.js';

describe('planPath — straight-line floor path + arrival facing', () => {
  it('endpoints are exact and t runs 0..1 monotonically', () => {
    const from = PATH_CASE.input.from;
    const to = PATH_CASE.input.to;
    const plan = planPath(from, to);
    const first = plan.samples[0];
    const last = plan.samples[plan.samples.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first!.pos).toEqual(from);
    expect(last!.pos[0]).toBeCloseTo(to[0], 10);
    expect(last!.pos[1]).toBeCloseTo(to[1], 10);
    expect(last!.pos[2]).toBeCloseTo(to[2], 10);
    expect(first!.t).toBe(0);
    expect(last!.t).toBeCloseTo(1, 10);
    for (let i = 1; i < plan.samples.length; i++) {
      expect(plan.samples[i]!.t).toBeGreaterThan(plan.samples[i - 1]!.t);
    }
  });

  it('reports the Euclidean length and the default station speed', () => {
    const plan = planPath(PATH_CASE.input.from, PATH_CASE.input.to);
    expect(plan.length).toBeCloseTo(PATH_CASE.expectedLength, 10);
    expect(plan.speed).toBe(STATION_SPEED); // 1.2 m/s default (avatarController.ts:68)
    expect(plan.gait).toBe('walk');
  });

  it('echoes the requested arrival facing (Mark.facing → arriveFacing, not hardcoded 0)', () => {
    const plan = planPath(PATH_CASE.input.from, PATH_CASE.input.to, { arriveFacing: PATH_CASE.input.arriveFacing });
    expect(plan.arriveFacing).toBe(PATH_CASE.input.arriveFacing);
  });

  it('omits arriveFacing when none is authored', () => {
    const plan = planPath([0, 0, 0], [1, 0, 0]);
    expect(plan.arriveFacing).toBeUndefined();
  });

  it('carries an explicit speed/gait override (replaces enumerated WALK/BACK paths)', () => {
    const plan = planPath([0, 0, 0], [0, 0, 3], { gait: 'stride', speed: 0.75 });
    expect(plan.speed).toBe(0.75);
    expect(plan.gait).toBe('stride');
  });

  it('a zero-length path still yields the two coincident endpoints', () => {
    const plan = planPath([1, 0, 1], [1, 0, 1]);
    expect(plan.length).toBe(0);
    expect(plan.samples.length).toBeGreaterThanOrEqual(2);
    expect(plan.samples[0]!.pos).toEqual([1, 0, 1]);
  });
});
