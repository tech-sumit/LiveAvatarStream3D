import { describe, it, expect } from 'vitest';
import { Stage, Target, Mark } from './stage.js';

const STAGE = {
  id: 'studio_a',
  marks: [
    { id: 'center', pos: [0, 0, 0] },
    { id: 'left_of_screen', pos: [-1.1, 0, 0.9] },
    { id: 'right_of_screen', pos: [1.1, 0, 0.9] },
    { id: 'enter_left', pos: [-3, 0, 0], facing: 'screen' }, // facing as a TargetRef
  ],
  targets: [
    { id: 'screen', kind: 'prop' as const, node: 'BackWall' },
    { id: 'desk', kind: 'prop' as const, pos: [0, 1, 0.5] },
    { id: 'camera', kind: 'point' as const, pos: [0, 1.6, -3] },
  ],
  savedShots: [
    { id: 'hero', pose: { pos: [0, 1.6, -3], target: [0, 1.5, 0], fov: 35 } },
  ],
};

describe('Stage', () => {
  it('parses a hand-written stage', () => {
    const s = Stage.parse(STAGE);
    expect(s.id).toBe('studio_a');
    expect(s.marks).toHaveLength(4);
    expect(s.targets).toHaveLength(3);
    expect(s.savedShots).toHaveLength(1);
  });

  it('populates empty arrays via defaults', () => {
    const s = Stage.parse({ id: 'bare' });
    expect(s.marks).toEqual([]);
    expect(s.targets).toEqual([]);
    expect(s.cameras).toEqual([]);
    expect(s.lights).toEqual([]);
    expect(s.props).toEqual([]);
    expect(s.savedShots).toEqual([]);
  });

  it('rejects an invalid Target.kind', () => {
    expect(() => Target.parse({ id: 'x', kind: 'bogus' })).toThrow();
  });

  it('accepts Mark.facing as both a number and a TargetRef string', () => {
    expect(Mark.parse({ id: 'm', pos: [0, 0, 0], facing: 1.57 }).facing).toBe(1.57);
    expect(Mark.parse({ id: 'm', pos: [0, 0, 0], facing: 'screen' }).facing).toBe('screen');
  });
});
