import type { ScriptSegment } from '@las/protocol';

/** Starter line for beat 0; additional beats start empty until the user fills them. */
export function newScriptSegment(seq: number): ScriptSegment {
  return {
    seq,
    text: seq === 0 ? 'Hello, welcome to the demo.' : '',
    emotion: 'neutral',
    gesture: 'none',
    posture: 'neutral',
    emphasis: [],
    pause_ms_after: 0,
  };
}

export function emptyScriptLineIndices(segments: ScriptSegment[]): number[] {
  return segments.flatMap((s, i) => (s.text.trim().length === 0 ? [i + 1] : []));
}
