import { VOICE_ENGINE_PRESETS, type TtsEngine, type VoiceProfile } from '@las/protocol';
import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { MediaRecorderBox } from './MediaRecorderBox.js';

type VoiceTab = 'existing' | 'clone';

interface Props {
  voices: VoiceProfile[];
  voiceId: string;
  onVoiceId: (id: string) => void;
  onVoicesChanged: () => void;
  onVoiceUpsert: (voice: VoiceProfile) => void;
  cloneBusy: boolean;
  onCloneBusy: (b: boolean) => void;
  onError: (msg: string | null) => void;
}

export function VoicePanel({
  voices,
  voiceId,
  onVoiceId,
  onVoicesChanged,
  onVoiceUpsert,
  cloneBusy,
  onCloneBusy,
  onError,
}: Props) {
  const [tab, setTab] = useState<VoiceTab>('existing');
  const fileRef = useRef<HTMLInputElement>(null);
  const [cloneLabel, setCloneLabel] = useState('');
  const [cloneEngine, setCloneEngine] = useState<TtsEngine>('xtts_v2');

  const readyVoices = voices.filter((v) => v.status === 'ready');
  const sortedVoices = [...voices].sort((a, b) => b.createdAt - a.createdAt);

  const [retryingId, setRetryingId] = useState<string | null>(null);

  async function retryClone(v: VoiceProfile) {
    setRetryingId(v.id);
    onError(null);
    try {
      const updated = await api.retryVoice(v.id);
      onVoiceUpsert(updated);
      onVoicesChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setRetryingId(null);
    }
  }

  async function cloneFromBlob(blob: Blob, filename: string) {
    onCloneBusy(true);
    onError(null);
    try {
      const contentType = blob.type || 'audio/webm';
      const { key, url } = await api.createUpload('voice_sample', contentType);
      await api.putToSignedUrl(url, blob);
      const created = await api.cloneVoice({
        sampleKey: key,
        label: cloneLabel.trim() || filename.replace(/\.[^.]+$/, ''),
        engine: cloneEngine,
      });
      onVoiceUpsert(created);
      onVoiceId(created.id);
      onVoicesChanged();
      setTab('existing');
      setCloneLabel('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      onError(String(e));
    } finally {
      onCloneBusy(false);
    }
  }

  async function cloneFromFile(file: File) {
    await cloneFromBlob(file, file.name);
  }

  return (
    <div className="card voice-card">
      <h2>Voice</h2>

      <div className="tab-bar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'existing'}
          className={`tab-btn ${tab === 'existing' ? 'active' : ''}`}
          onClick={() => setTab('existing')}
        >
          Existing
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'clone'}
          className={`tab-btn ${tab === 'clone' ? 'active' : ''}`}
          onClick={() => setTab('clone')}
        >
          Clone new
        </button>
      </div>

      {tab === 'existing' && (
        <div className="tab-panel" role="tabpanel">
          {sortedVoices.length === 0 ? (
            <div className="empty-state">
              No voices yet.
              <br />
              Switch to <strong>Clone new</strong> to record or upload a sample.
            </div>
          ) : (
            <ul className="voice-list">
              {sortedVoices.map((v) => {
                const isReady = v.status === 'ready';
                const isPending = v.status === 'cloning' || v.status === 'pending';
                const isFailed = v.status === 'failed';
                const canRetry = isFailed || isPending;
                return (
                  <li key={v.id} className="voice-list-item">
                    <button
                      type="button"
                      className={`voice-row ${voiceId === v.id && isReady ? 'selected' : ''} ${!isReady ? 'disabled' : ''}`}
                      disabled={!isReady}
                      onClick={() => isReady && onVoiceId(v.id)}
                    >
                      <span className="voice-row-label">{v.label}</span>
                      <span className={`voice-status-badge ${v.status}`}>
                        {isPending ? 'cloning…' : v.status}
                      </span>
                      <span className="voice-row-meta">{v.engine}</span>
                    </button>
                    {v.error && (
                      <p className="voice-row-error" title={v.error}>
                        {v.error.length > 120 ? `${v.error.slice(0, 120)}…` : v.error}
                      </p>
                    )}
                    {canRetry && (
                      <button
                        type="button"
                        className="btn sm voice-retry-btn"
                        disabled={retryingId === v.id || cloneBusy}
                        onClick={() => void retryClone(v)}
                      >
                        {retryingId === v.id ? 'Retrying…' : 'Retry clone'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {voiceId && readyVoices.some((v) => v.id === voiceId) && (
            <p className="voice-selected-hint">
              Selected for render: <strong>{readyVoices.find((v) => v.id === voiceId)?.label}</strong>
            </p>
          )}

          {sortedVoices.some((v) => v.status === 'cloning' || v.status === 'pending') && (
            <p className="voice-selected-hint">GPU is cloning — list refreshes every 2s until ready.</p>
          )}
        </div>
      )}

      {tab === 'clone' && (
        <div className="tab-panel" role="tabpanel">
          <label>Engine preset</label>
          <div className="preset-grid">
            {VOICE_ENGINE_PRESETS.map((p) => (
              <button
                key={p.engine}
                type="button"
                className={`preset-chip ${cloneEngine === p.engine ? 'selected' : ''}`}
                onClick={() => setCloneEngine(p.engine)}
                title={p.description}
              >
                <strong>{p.label}</strong>
                {p.recommended && <span className="tag">recommended</span>}
                <span className="preset-desc">{p.description}</span>
              </button>
            ))}
          </div>

          <label>Label</label>
          <input
            value={cloneLabel}
            onChange={(e) => setCloneLabel(e.target.value)}
            placeholder="e.g. Sumit demo"
          />

          <label>Record a sample (10–30s)</label>
          <MediaRecorderBox
            disabled={cloneBusy}
            onRecorded={(blob) => void cloneFromBlob(blob, 'recorded-sample.webm')}
          />

          <label className="or-divider">or upload a file</label>
          <input ref={fileRef} type="file" accept="audio/*,video/*,.mp4,.wav,.webm,.m4a" />

          <button
            type="button"
            className="btn sm"
            disabled={cloneBusy}
            onClick={() => {
              const f = fileRef.current?.files?.[0];
              if (!f) {
                onError('Choose an audio or video file first');
                return;
              }
              void cloneFromFile(f);
            }}
          >
            {cloneBusy ? 'Cloning on GPU…' : `Start clone (${cloneEngine})`}
          </button>
        </div>
      )}
    </div>
  );
}
