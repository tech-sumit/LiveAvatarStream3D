import { RT_TRACKS, parseServerEvent, type SessionMedia, type TurnSource } from '@las/protocol';
import { API_BASE } from './api.js';

interface Handlers {
  onRemoteStream: (stream: MediaStream) => void;
  onStatus: (status: string) => void;
  /** A finalized user turn echoed by the server (spoken or typed). */
  onUserTurn?: (text: string, source: TurnSource) => void;
  /** Avatar reply, streamed incrementally; `final` marks the last update. */
  onAvatarReply?: (text: string, final: boolean) => void;
}

// The GPU warms MuseTalk + XTTS per session (~75s measured E2E) before it
// publishes the avatar tracks, so the subscribe poll needs a wall-clock budget
// that comfortably covers that warm rather than a small fixed attempt count.
const SUBSCRIBE_BUDGET_MS = 120_000;
const SUBSCRIBE_BACKOFF_START_MS = 400;
const SUBSCRIBE_BACKOFF_CAP_MS = 2500;
const WAITING_STATUS = 'waiting for avatar to start…';

/**
 * Browser-side WebRTC client for a realtime avatar session.
 *
 * Media is routed by the Cloudflare Realtime SFU and driven through the
 * control-plane `/rt/*` routes. The browser publishes mic audio (pubPc) and
 * subscribes to the avatar's audio+video (subPc). Barge-in / mute / end travel
 * over the SessionDO control WebSocket.
 */
export class RealtimeClient {
  private pubPc: RTCPeerConnection | null = null;
  private subPc: RTCPeerConnection | null = null;
  private control: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private readonly base: string;

  constructor(
    private media: SessionMedia,
    private handlers: Handlers,
  ) {
    this.base = `${API_BASE}/sessions/${media.sessionId}`;
  }

  async connect(): Promise<void> {
    this.handlers.onStatus('connecting');
    try {
      this.openControl();
      await this.publishMic();
      await this.subscribeAvatar();
    } catch (err) {
      // Any failure mid-connect (mic denied, publish/subscribe throw) must not
      // leave the control WS / pubPc / subPc / mic stream dangling.
      this.teardownLocal();
      throw err;
    }
  }

  /** Publish mic audio: sendonly offer -> SFU answer via /rt/publish. */
  private async publishMic(): Promise<void> {
    const iceServers = this.media.iceServers;
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [track] = this.micStream.getAudioTracks();
    if (!track) throw new Error('no microphone track available');

    this.pubPc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    const transceiver = this.pubPc.addTransceiver(track, { direction: 'sendonly' });

    const offer = await this.pubPc.createOffer();
    await this.pubPc.setLocalDescription(offer);

    const audioMid = transceiver.mid;
    if (audioMid === null) throw new Error('publish offer produced no audio mid');

    const res = await fetch(`${this.base}/rt/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peer: 'browser',
        sdp: this.pubPc.localDescription?.sdp ?? offer.sdp ?? '',
        tracks: [{ mid: audioMid, trackName: RT_TRACKS.micAudio, kind: 'audio' }],
      }),
    });
    if (!res.ok) throw new Error(`publish failed: ${res.status} ${await res.text().catch(() => '')}`);

    const { sdp } = (await res.json()) as { sdp: string };
    await this.pubPc.setRemoteDescription({ type: 'answer', sdp });
  }

  /**
   * Subscribe to the avatar's audio+video. The SFU returns an offer (which we
   * answer + renegotiate). HTTP 425 means the GPU peer hasn't published yet —
   * retry with exponential backoff inside a wall-clock budget before failing.
   */
  private async subscribeAvatar(): Promise<void> {
    const iceServers = this.media.iceServers;
    this.subPc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

    const remote = new MediaStream();
    this.subPc.ontrack = (ev) => {
      remote.addTrack(ev.track);
      this.handlers.onRemoteStream(remote);
    };

    this.handlers.onStatus('subscribing');
    const offerSdp = await this.requestSubscribeOffer();

    await this.subPc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.subPc.createAnswer();
    await this.subPc.setLocalDescription(answer);

    const res = await fetch(`${this.base}/rt/renegotiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peer: 'browser',
        sdp: this.subPc.localDescription?.sdp ?? answer.sdp ?? '',
      }),
    });
    if (!res.ok)
      throw new Error(`renegotiate failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  /** Poll /rt/subscribe until the GPU peer is live (or the budget is spent). */
  private async requestSubscribeOffer(): Promise<string> {
    const deadline = Date.now() + SUBSCRIBE_BUDGET_MS;
    let backoff = SUBSCRIBE_BACKOFF_START_MS;
    let waited = false;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.base}/rt/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          peer: 'browser',
          refs: [RT_TRACKS.avatarAudio, RT_TRACKS.avatarVideo],
        }),
      });
      if (res.status === 425) {
        if (!waited) {
          this.handlers.onStatus(WAITING_STATUS);
          waited = true;
        }
        await delay(Math.min(backoff, Math.max(0, deadline - Date.now())));
        backoff = Math.min(backoff * 2, SUBSCRIBE_BACKOFF_CAP_MS);
        continue;
      }
      if (!res.ok)
        throw new Error(`subscribe failed: ${res.status} ${await res.text().catch(() => '')}`);
      const { sdp } = (await res.json()) as { sdp: string; tracks: { mid: string; trackName: string }[] };
      return sdp;
    }
    throw new Error(
      `avatar tracks not available after ${Math.round(SUBSCRIBE_BUDGET_MS / 1000)}s (GPU peer never published)`,
    );
  }

  private openControl(): void {
    this.control = new WebSocket(controlWsUrl(this.base));
    this.control.addEventListener('open', () => this.handlers.onStatus('control-open'));
    this.control.addEventListener('message', (ev) => this.onServerEvent(String(ev.data)));
  }

  private onServerEvent(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const evt = parseServerEvent(parsed);
    if (!evt) return;
    switch (evt.type) {
      case 'user_turn':
        this.handlers.onUserTurn?.(evt.text, evt.source);
        return;
      case 'avatar_reply':
        this.handlers.onAvatarReply?.(evt.text, evt.final);
        return;
      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  }

  bargeIn(): void {
    this.send({ type: 'barge_in' });
  }

  setMuted(muted: boolean): void {
    this.micStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.send({ type: 'mute', muted });
  }

  /** Submit a typed user turn over the same `/turn` endpoint the GPU STT uses,
   *  tagged `source:'text'` so the server skips the internal-token gate. The
   *  resulting transcript flows back over the control WS like a spoken turn. */
  async sendTextTurn(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const res = await fetch(`${this.base}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: trimmed, source: 'text' }),
    });
    if (!res.ok) throw new Error(`turn failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  private send(msg: unknown): void {
    if (this.control?.readyState === WebSocket.OPEN) this.control.send(JSON.stringify(msg));
  }

  // Single end path is the DELETE /sessions/:id (api.endSession) issued by the
  // caller — we don't also fire the control-WS {type:'end'} here to avoid a
  // double end. close() only releases local resources (WS, PCs, mic stream).
  async close(): Promise<void> {
    this.teardownLocal();
  }

  private teardownLocal(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.pubPc?.close();
    this.subPc?.close();
    this.control?.close();
    this.pubPc = null;
    this.subPc = null;
    this.control = null;
    this.micStream = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive the ws/wss control URL from the (possibly relative) API base. */
function controlWsUrl(base: string): string {
  const path = `${base}/control`;
  if (path.startsWith('http')) return path.replace(/^http/, 'ws');
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}
