import { describe, it, expect } from 'vitest';
import { composeShot } from './composeShot.js';

// Phase-0 harness smoke: proves the vitest config + barrel resolve before any math is pinned.
// Real golden/regression fixtures arrive in Phase 2.
describe('composeShot (harness smoke)', () => {
  it('is exported as a function', () => {
    expect(typeof composeShot).toBe('function');
  });

  it('throws until implemented (Phase 2)', () => {
    expect(() => composeShot([{ pos: [0, 0, 0] }], { size: 'medium' })).toThrow(/not implemented/);
  });
});
