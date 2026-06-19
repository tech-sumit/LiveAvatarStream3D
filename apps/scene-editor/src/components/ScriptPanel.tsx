import { EMOTIONS, GESTURES, POSTURES, type ScriptSegment } from '@las/protocol';
import { newScriptSegment } from '../lib/scriptSegment.js';

interface Props {
  segments: ScriptSegment[];
  onSegments: (s: ScriptSegment[]) => void;
  /** Set after Record blocked on empty lines — outlines empty textareas. */
  highlightEmpty?: boolean;
}

export function ScriptPanel({ segments, onSegments, highlightEmpty = false }: Props) {
  function update(i: number, patch: Partial<ScriptSegment>) {
    onSegments(segments.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  return (
    <div className="card">
      <h2>Dialog &amp; lip-sync</h2>
      <p className="muted">What the avatar says — required before Record.</p>

      {segments.map((seg, i) => {
        const isEmpty = seg.text.trim().length === 0;
        return (
          <div key={i} className={`segment${highlightEmpty && isEmpty ? ' segment-empty' : ''}`}>
            <label className="segment-label">Line {i + 1}</label>
            <textarea
              rows={2}
              value={seg.text}
              placeholder="Type what the avatar should say…"
              aria-invalid={highlightEmpty && isEmpty}
              onChange={(e) => update(i, { text: e.target.value })}
            />
            <div className="seg-controls">
              <select
                value={seg.emotion}
                onChange={(e) => update(i, { emotion: e.target.value as ScriptSegment['emotion'] })}
              >
                {EMOTIONS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select
                value={seg.gesture}
                onChange={(e) => update(i, { gesture: e.target.value as ScriptSegment['gesture'] })}
              >
                {GESTURES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select
                value={seg.posture}
                onChange={(e) => update(i, { posture: e.target.value as ScriptSegment['posture'] })}
              >
                {POSTURES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        className="btn sm secondary"
        onClick={() => onSegments([...segments, newScriptSegment(segments.length)])}
      >
        + Line
      </button>
    </div>
  );
}
