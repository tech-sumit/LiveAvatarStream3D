import { describe, it, expect } from 'vitest';
import { Score, Cue, validateScore } from './score.js';

const SCORE = {
  stage: 'studio_a',
  defaults: { emotion: 'neutral' as const, gait: 'walk' as const },
  beats: [
    {
      text: 'Welcome to the show',
      emphasis: ['Welcome'],
      emotion: 'warm' as const,
      cues: [
        { move: { to: 'left_of_screen', gait: 'walk' as const } },
        { at: { word: 2 }, look: { at: 'screen' } },
        {
          camera: { frame: { subjects: ['self.face', 'screen'] }, follow: true },
        },
      ],
      pauseMsAfter: 300,
    },
    {
      text: 'And here is the news',
      cues: [
        { gesture: { kind: 'point' as const, target: 'screen', hand: 'auto' as const } },
        { at: { word: 1 }, emote: { emotion: 'excited' as const, intensity: 0.7 } },
        { camera: { move: 'dolly' as const, amount: -0.5 } },
        { turn: { to: 'screen' } },
        { camera: { shot: 'hero' } }, // savedShot ref
      ],
    },
  ],
};

describe('Score', () => {
  it('parses the example Score and round-trips fields', () => {
    const s = Score.parse(SCORE);
    expect(s.stage).toBe('studio_a');
    expect(s.beats).toHaveLength(2);
    const b0 = s.beats[0]!;
    expect(b0.emphasis).toEqual(['Welcome']);
    expect(b0.pauseMsAfter).toBe(300);
    expect(b0.cues).toHaveLength(3);
    // WordAnchor round-trips
    const look = b0.cues[1]!;
    if ('look' in look) {
      expect(look.at?.word).toBe(2);
      expect(look.look.at).toBe('screen');
    } else {
      throw new Error('expected look cue');
    }
  });

  it('parses defaults', () => {
    const s = Score.parse(SCORE);
    expect(s.defaults?.emotion).toBe('neutral');
    expect(s.defaults?.gait).toBe('walk');
  });

  it('parses all six Cue variants and the discriminated bodies type-narrow', () => {
    const move = Cue.parse({ move: { to: 'left_of_screen' } });
    if ('move' in move) expect(move.move.to).toBe('left_of_screen');
    else throw new Error('move');

    const turn = Cue.parse({ turn: { to: 'screen' } });
    if ('turn' in turn) expect(turn.turn.to).toBe('screen');
    else throw new Error('turn');

    const gesture = Cue.parse({ gesture: { kind: 'wave' } });
    if ('gesture' in gesture) expect(gesture.gesture.kind).toBe('wave');
    else throw new Error('gesture');

    const look = Cue.parse({ look: { at: 'camera' } });
    if ('look' in look) expect(look.look.at).toBe('camera');
    else throw new Error('look');

    const camera = Cue.parse({ camera: { move: 'orbit', amount: 0.5 } });
    if ('camera' in camera && 'move' in camera.camera) expect(camera.camera.move).toBe('orbit');
    else throw new Error('camera');

    const emote = Cue.parse({ emote: { emotion: 'excited', intensity: 0.7 } });
    if ('emote' in emote) {
      expect(emote.emote.emotion).toBe('excited');
      expect(emote.emote.intensity).toBe(0.7);
    } else throw new Error('emote');
  });

  it('validateScore accepts the example', () => {
    expect(validateScore(SCORE).stage).toBe('studio_a');
  });
});
