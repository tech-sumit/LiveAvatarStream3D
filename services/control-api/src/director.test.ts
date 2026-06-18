import { describe, it, expect } from 'vitest';
import { jsonlToScript } from './director.js';

describe('jsonlToScript', () => {
  it('parses JSONL segments into a validated script', () => {
    const text = [
      '{"text":"Hello there.","emotion":"warm","gesture":"wave"}',
      '{"text":"Let me show you.","gesture":"point","posture":"leaning_in"}',
    ].join('\n');
    const script = jsonlToScript(text, 'en');
    expect(script.segments).toHaveLength(2);
    const [first, second] = script.segments;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.emotion).toBe('warm');
    expect(first!.seq).toBe(0);
    expect(second!.seq).toBe(1);
    expect(second!.gesture).toBe('point');
  });

  it('strips code fences and skips malformed lines', () => {
    const text = ['```json', '{"text":"One."}', 'not json', '{"text":"Two."}', '```'].join('\n');
    const script = jsonlToScript(text, 'en');
    expect(script.segments).toHaveLength(2);
    expect(script.segments.map((s) => s.text)).toEqual(['One.', 'Two.']);
  });

  it('falls back to a single segment when no JSON is present', () => {
    const script = jsonlToScript('just plain narration text', 'en');
    expect(script.segments).toHaveLength(1);
    const [only] = script.segments;
    expect(only).toBeDefined();
    expect(only!.text).toContain('plain narration');
  });
});
