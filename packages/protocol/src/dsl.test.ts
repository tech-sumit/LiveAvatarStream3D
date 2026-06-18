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
  it('embeds the enumerated vocabularies', () => {
    const p = buildDirectorSystemPrompt('Be friendly.');
    expect(p).toContain('warm');
    expect(p).toContain('open_palms');
    expect(p).toContain('leaning_in');
    expect(p).toContain('Be friendly.');
  });
});
