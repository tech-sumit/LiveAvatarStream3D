import { useEffect, useRef, useState } from 'react';
import type { AvatarProfile, VoiceProfile, SessionMedia, TurnSource } from '@las/protocol';
import { api } from '../lib/api.js';
import { RealtimeClient } from '../lib/realtime.js';

interface ChatEntry {
  role: 'user' | 'avatar';
  text: string;
}

export function RealtimePage() {
  const [avatars, setAvatars] = useState<AvatarProfile[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [avatarId, setAvatarId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [persona, setPersona] = useState('You are a friendly product specialist.');
  const [media, setMedia] = useState<SessionMedia | null>(null);
  const [status, setStatus] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<RealtimeClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Avatar replies stream incrementally: coalesce onto the last avatar entry
  // until `final`, but only if it directly follows the user turn it answers (a
  // preceding user entry means start a fresh avatar bubble).
  function appendUserTurn(text: string, _source: TurnSource) {
    setTranscript((prev) => [...prev, { role: 'user', text }]);
  }
  function appendAvatarReply(text: string, _final: boolean) {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'avatar') {
        const next = prev.slice(0, -1);
        next.push({ role: 'avatar', text });
        return next;
      }
      return [...prev, { role: 'avatar', text }];
    });
  }

  useEffect(() => {
    void (async () => {
      const [a, v] = await Promise.all([api.listAvatars(), api.listVoices()]);
      setAvatars(a);
      setVoices(v);
      if (a[0]) setAvatarId(a[0].id);
      if (v[0]) setVoiceId(v[0].id);
    })().catch((e) => setError(String(e)));
  }, []);

  // Navigating away while live must release the mic stream, pubPc/subPc and
  // control WS, and end the GPU session so the node isn't held indefinitely.
  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id) void api.endSession(id).catch(() => {});
    };
  }, []);

  function enableSound() {
    void videoRef.current
      ?.play()
      .then(() => setNeedsTapToPlay(false))
      .catch(() => setNeedsTapToPlay(true));
  }

  async function start() {
    setError(null);
    setNeedsTapToPlay(false);
    setTranscript([]);
    setStatus('allocating');
    try {
      const m = await api.startSession({ avatarId, voiceId, persona, tier: 'fast' });
      setMedia(m);
      sessionIdRef.current = m.sessionId;
      const client = new RealtimeClient(m, {
        onRemoteStream: (stream) => {
          const el = videoRef.current;
          if (!el) return;
          el.srcObject = stream;
          // Autoplay with sound can be blocked (Safari/iOS, sometimes Chrome).
          // Explicitly start playback; on rejection surface a tap-to-enable CTA.
          void el
            .play()
            .then(() => setNeedsTapToPlay(false))
            .catch(() => setNeedsTapToPlay(true));
        },
        onStatus: setStatus,
        onUserTurn: appendUserTurn,
        onAvatarReply: appendAvatarReply,
      });
      clientRef.current = client;
      setMuted(false);
      await client.connect();
      setStatus('live');
      // The Start click is a real user gesture; if the stream is already
      // attached, nudge playback so audio starts without a second tap.
      if (videoRef.current?.srcObject) enableSound();
    } catch (e) {
      // connect() tears down its own partial state, but also drop our ref so a
      // retry constructs a fresh client instead of leaking the half-open one.
      await clientRef.current?.close();
      clientRef.current = null;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      if (id) await api.endSession(id).catch(() => {});
      setMedia(null);
      setError(`${String(e)} — please try again.`);
      setStatus('failed');
    }
  }

  async function stop() {
    await clientRef.current?.close();
    clientRef.current = null;
    const id = sessionIdRef.current ?? media?.sessionId;
    sessionIdRef.current = null;
    if (id) await api.endSession(id).catch(() => {});
    setMedia(null);
    setMuted(false);
    setNeedsTapToPlay(false);
    setStatus('idle');
  }

  function toggleMute() {
    const next = !muted;
    clientRef.current?.setMuted(next);
    setMuted(next);
  }

  function sendText() {
    const text = draft.trim();
    if (!text || status !== 'live') return;
    setDraft('');
    void clientRef.current?.sendTextTurn(text).catch((e) => setError(String(e)));
  }

  return (
    <div>
      <h1>Live</h1>
      <p className="sub">
        Talk to the avatar. Speech in, avatar video out. A director LLM streams gesture/emotion
        beats in realtime. Interrupt anytime (barge-in).
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="seg-controls" style={{ gridTemplateColumns: '1fr 1fr' }}>
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
        </div>
        <label>Persona / behavior (director prompt)</label>
        <textarea rows={2} value={persona} onChange={(e) => setPersona(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          {status === 'idle' || status === 'failed' ? (
            <button className="btn" disabled={!avatarId || !voiceId} onClick={start}>
              Start session
            </button>
          ) : (
            <>
              <button className="btn secondary" onClick={() => clientRef.current?.bargeIn()}>
                Interrupt
              </button>
              <button className="btn secondary" onClick={toggleMute}>
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="btn" onClick={stop}>
                End
              </button>
            </>
          )}
          <span className="badge">{status}</span>
        </div>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>

      {needsTapToPlay && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn" onClick={enableSound}>
            Tap to enable sound
          </button>
        </div>
      )}

      <video ref={videoRef} autoPlay playsInline />

      <div className="card" style={{ marginTop: 16 }}>
        <label>Conversation</label>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 280,
            overflowY: 'auto',
            padding: '8px 0',
          }}
        >
          {transcript.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              Talk to the avatar or type a message below — both work at any time.
            </p>
          ) : (
            transcript.map((entry, i) => (
              <div
                key={i}
                style={{ alignSelf: entry.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}
              >
                <span
                  className="badge"
                  style={{ display: 'inline-block', marginBottom: 2, opacity: 0.7 }}
                >
                  {entry.role === 'user' ? 'You' : 'Avatar'}
                </span>
                <div
                  style={{
                    background: entry.role === 'user' ? 'var(--accent, #2b6cb0)' : 'var(--panel, #222)',
                    color: entry.role === 'user' ? '#fff' : 'inherit',
                    borderRadius: 10,
                    padding: '8px 12px',
                  }}
                >
                  {entry.text}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            type="text"
            value={draft}
            placeholder={status === 'live' ? 'Type a message…' : 'Start a session to chat'}
            disabled={status !== 'live'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendText();
              }
            }}
            style={{ flex: 1 }}
          />
          <button className="btn" disabled={status !== 'live' || !draft.trim()} onClick={sendText}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
