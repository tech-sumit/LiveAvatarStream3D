import { useEffect, useState } from 'react';
import {
  EMOTIONS,
  GESTURES,
  POSTURES,
  type AvatarProfile,
  type VoiceProfile,
  type ScriptSegment,
  type Job,
  type JobEvent,
} from '@las/protocol';
import { api } from '../lib/api.js';

type Seg = Omit<ScriptSegment, 'emphasis'> & { emphasis: string[] };

const blankSegment = (seq: number): Seg => ({
  seq,
  text: '',
  emotion: 'neutral',
  gesture: 'none',
  posture: 'neutral',
  emphasis: [],
  pause_ms_after: 0,
});

export function StudioPage() {
  const [avatars, setAvatars] = useState<AvatarProfile[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [avatarId, setAvatarId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [tier, setTier] = useState('premium');
  const [segments, setSegments] = useState<Seg[]>([blankSegment(0)]);
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [a, v] = await Promise.all([api.listAvatars(), api.listVoices()]);
      setAvatars(a);
      setVoices(v);
      if (a[0]) setAvatarId(a[0].id);
      if (v[0]) setVoiceId(v[0].id);
    })().catch((e) => setError(String(e)));
  }, []);

  // Poll job status while running.
  useEffect(() => {
    if (!job || job.status === 'succeeded' || job.status === 'failed') return;
    const t = setInterval(async () => {
      try {
        const { job: j, events: ev } = await api.getJob(job.id);
        setJob(j);
        setEvents(ev);
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job]);

  function update(i: number, patch: Partial<Seg>) {
    setSegments((s) => s.map((seg, idx) => (idx === i ? { ...seg, ...patch } : seg)));
  }

  async function draft() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const script = await api.draftScript(prompt);
      setSegments(script.segments.map((s) => ({ ...s, emphasis: s.emphasis ?? [] })));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const j = await api.createRenderJob({
        avatarId,
        voiceId,
        tier: tier as 'fast' | 'premium',
        fps: 30,
        script: { version: 1, language: 'en', segments },
      });
      setJob(j);
      setEvents([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const done = job?.status === 'succeeded';

  return (
    <div>
      <h1>Studio</h1>
      <p className="sub">Author a performance script and render a 1080p talking-head video.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="seg-controls" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div>
            <label>Avatar</label>
            <select value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
              {avatars.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Voice</label>
            <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Tier</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="premium">Premium</option>
              <option value="fast">Fast</option>
            </select>
          </div>
        </div>

        <label>LLM-assist: describe what the avatar should say</label>
        <div className="row">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A warm 20s welcome to our new hires"
          />
          <button className="btn secondary" disabled={busy} onClick={draft}>
            Draft
          </button>
        </div>
      </div>

      {segments.map((seg, i) => (
        <div className="segment" key={i}>
          <textarea
            rows={2}
            value={seg.text}
            placeholder={`Segment ${i + 1} text`}
            onChange={(e) => update(i, { text: e.target.value })}
          />
          <div className="seg-controls">
            <select value={seg.emotion} onChange={(e) => update(i, { emotion: e.target.value as Seg['emotion'] })}>
              {EMOTIONS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <select value={seg.gesture} onChange={(e) => update(i, { gesture: e.target.value as Seg['gesture'] })}>
              {GESTURES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <select value={seg.posture} onChange={(e) => update(i, { posture: e.target.value as Seg['posture'] })}>
              {POSTURES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input
              type="number"
              value={seg.pause_ms_after}
              onChange={(e) => update(i, { pause_ms_after: Number(e.target.value) })}
              placeholder="pause ms"
            />
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn secondary"
          onClick={() => setSegments((s) => [...s, blankSegment(s.length)])}
        >
          + Add segment
        </button>
        <button className="btn" disabled={busy || !avatarId || !voiceId} onClick={submit}>
          Render video
        </button>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {job && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Job {job.id.slice(0, 8)}</strong>
            <span className={`badge ${done ? 'ready' : job.status === 'failed' ? 'failed' : ''}`}>
              {job.status}
            </span>
          </div>
          <ul className="sub">
            {events.map((e) => (
              <li key={e.id}>
                {e.status ?? e.kind}
                {e.progress != null ? ` ${Math.round(e.progress * 100)}%` : ''}
                {e.message ? ` — ${e.message}` : ''}
              </li>
            ))}
          </ul>
          {done && (
            <a className="btn" href={api.jobDownloadUrl(job.id)}>
              Download 1080p mp4
            </a>
          )}
        </div>
      )}
    </div>
  );
}
