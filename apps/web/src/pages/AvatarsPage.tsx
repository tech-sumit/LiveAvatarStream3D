import { useEffect, useRef, useState } from 'react';
import type { AvatarProfile } from '@las/protocol';
import { api } from '../lib/api.js';
import { MediaRecorderBox } from '../components/MediaRecorderBox.js';

export function AvatarsPage() {
  const [avatars, setAvatars] = useState<AvatarProfile[]>([]);
  const [label, setLabel] = useState('');
  const [tier, setTier] = useState('premium');
  const [fineTune, setFineTune] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      setAvatars(await api.listAvatars());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function submitVideo(blob: Blob, contentType: string) {
    setBusy(true);
    setError(null);
    try {
      const { key, url } = await api.createUpload('reference_video', contentType);
      await api.putToSignedUrl(url, blob);
      await api.buildAvatar({
        sourceType: 'reference_video',
        sourceKey: key,
        label: label || undefined,
        tier,
        fineTune,
      });
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
      <h1>Avatars</h1>
      <p className="sub">
        Build an avatar from a short reference video (30s-2min) for best realism. Image upload /
        generated stills are the fast fallback tier.
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <label>Label</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My avatar" />
        <div className="seg-controls" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div>
            <label>Tier</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="premium">Premium (max fidelity)</option>
              <option value="fast">Fast</option>
            </select>
          </div>
          <div>
            <label>Per-avatar fine-tune (async)</label>
            <select
              value={fineTune ? 'yes' : 'no'}
              onChange={(e) => setFineTune(e.target.value === 'yes')}
            >
              <option value="no">No</option>
              <option value="yes">Yes (LoRA)</option>
            </select>
          </div>
        </div>

        <label>Record a reference video</label>
        <MediaRecorderBox
          video
          audio
          onRecorded={(blob) => submitVideo(blob, 'video/webm')}
          disabled={busy}
        />

        <label>...or upload one</label>
        <div className="row">
          <input ref={fileRef} type="file" accept="video/*" />
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              const f = fileRef.current?.files?.[0];
              if (f) void submitVideo(f, f.type || 'video/mp4');
            }}
          >
            Build avatar
          </button>
        </div>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>

      <div className="grid">
        {avatars.map((a) => (
          <div className="card" key={a.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{a.label}</strong>
              <span className={`badge ${a.status === 'ready' ? 'ready' : a.status === 'failed' ? 'failed' : ''}`}>
                {a.status}
              </span>
            </div>
            <p className="sub" style={{ marginTop: 8 }}>
              {a.sourceType} · {a.tier}
              {a.hasLora ? ' · LoRA' : ''}
            </p>
          </div>
        ))}
        {avatars.length === 0 && <p className="sub">No avatars yet.</p>}
      </div>
    </div>
  );
}
