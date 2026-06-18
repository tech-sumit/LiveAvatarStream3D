import { useEffect, useRef, useState } from 'react';
import type { VoiceProfile } from '@las/protocol';
import { api } from '../lib/api.js';
import { MediaRecorderBox } from '../components/MediaRecorderBox.js';

export function VoicesPage() {
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [label, setLabel] = useState('');
  const [engine, setEngine] = useState('fish_s2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      setVoices(await api.listVoices());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function submitSample(blob: Blob, contentType: string) {
    setBusy(true);
    setError(null);
    try {
      const { key, url } = await api.createUpload('voice_sample', contentType);
      await api.putToSignedUrl(url, blob);
      await api.cloneVoice({ sampleKey: key, label: label || undefined, engine });
      setLabel('');
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Voices</h1>
      <p className="sub">Clone a voice from a clean 10-30s sample. Streaming engines power realtime.</p>

      <div className="card" style={{ marginBottom: 24 }}>
        <label>Label</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My voice" />
        <label>Engine</label>
        <select value={engine} onChange={(e) => setEngine(e.target.value)}>
          <option value="fish_s2">Fish Audio S2 (quality, offline)</option>
          <option value="cosyvoice2">CosyVoice 2 (streaming)</option>
          <option value="xtts_v2">XTTS-v2 (streaming)</option>
          <option value="chatterbox">Chatterbox-Turbo (streaming)</option>
        </select>

        <label>Record a sample</label>
        <MediaRecorderBox audio onRecorded={(b) => submitSample(b, 'audio/webm')} disabled={busy} />

        <label>...or upload one</label>
        <div className="row">
          <input ref={fileRef} type="file" accept="audio/*" />
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              const f = fileRef.current?.files?.[0];
              if (f) void submitSample(f, f.type || 'audio/wav');
            }}
          >
            Clone voice
          </button>
        </div>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>

      <div className="grid">
        {voices.map((v) => (
          <div className="card" key={v.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{v.label}</strong>
              <span className={`badge ${v.status === 'ready' ? 'ready' : v.status === 'failed' ? 'failed' : ''}`}>
                {v.status}
              </span>
            </div>
            <p className="sub" style={{ marginTop: 8 }}>
              {v.engine} · {v.language}
            </p>
          </div>
        ))}
        {voices.length === 0 && <p className="sub">No voices yet.</p>}
      </div>
    </div>
  );
}
