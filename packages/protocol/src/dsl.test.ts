import { describe, it, expect } from 'vitest';
import { parseScript, Script, StreamedSegment } from './dsl.js';
import { buildDirectorSystemPrompt } from './director.js';

describe('script DSL', () => {
  it('applies defaults to a minimal segment', () => {
    const s = parseScript({ segments: [{ seq: 0, text: 'hello' }] });
    expect(s.version).toBe(1);
    expect(s.language).toBe('en');
    expect(s.segments[0]).toMatchObject({
      emotion: 'neutral',
      gesture: 'none',
      posture: 'neutral',
      emphasis: [],
      pause_ms_after: 0,
    });
  });

  it('rejects an empty script', () => {
    expect(() => Script.parse({ segments: [] })).toThrow();
  });

  it('rejects an unknown emotion', () => {
    expect(() =>
      parseScript({ segments: [{ seq: 0, text: 'hi', emotion: 'furious' }] }),
    ).toThrow();
  });

  it('requires turnId + final on a streamed segment', () => {
    const seg = StreamedSegment.parse({
      seq: 0,
      turnId: 't1',
      text: 'streaming beat',
      final: true,
    });
    expect(seg.turnId).toBe('t1');
    expect(seg.final).toBe(true);
  });
});

describe('director system prompt', () => {
  // The director now emits a Score (Phase 5), so the prompt embeds the Score preset
  // vocabularies (camelCase GestureKind / EmotionPreset) rather than the legacy dsl
  // JSONL enums. The exhaustive coverage lives in director.test.ts.
  it('embeds the Score preset vocabularies and the persona', () => {
    const p = buildDirectorSystemPrompt('Be friendly.');
    expect(p).toContain('warm'); // an EmotionPreset
    expect(p).toContain('openPalms'); // a GestureKind (camelCase Score vocab)
    expect(p).toContain('"beats"');
    expect(p).toContain('Be friendly.');
  });
});
