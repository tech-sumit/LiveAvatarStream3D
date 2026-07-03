import type { SpeakHandle, SpeakHooks, SpeakOpts, TtsSource } from './types.js';

// ElevenLabs TTS. Two transports, same class:
//  - dev server: a same-origin proxy path (default `/eleven`, see vite.config.ts)
//    injects the `xi-api-key` header server-side, so the key never reaches the browser.
//  - static hosting (the pages.dev demo has no proxy): call the API directly with a
//    visitor-supplied key (`apiKey`) — the ElevenLabs API is CORS-open, and the key
//    lives only in that visitor's browser (localStorage).
// Audio is played through Web Audio, so AudioAnalyserLipsync drives the mouth from
// the real waveform (amplitude-accurate sync to the actual voice).
const MODEL_ID = 'eleven_turbo_v2_5';

export class ElevenLabsTts implements TtsSource {
  readonly kind = 'server' as const;
  private ctx: AudioContext | null = null;

  /** Base for direct-from-browser calls when there is no dev-server proxy. */
  static readonly DIRECT_BASE = 'https://api.elevenlabs.io/v1';

  /**
   * @param getCtx  optional shared AudioContext (so its output can be recorded)
   * @param getTap  optional extra node to also route audio into (e.g. a
   *                MediaStreamAudioDestinationNode for capturing voice in clips)
   * @param apiKey  visitor-supplied key for direct API calls (omit with the proxy)
   */
  constructor(
    private base = '/eleven',
    private getCtx?: () => AudioContext,
    private getTap?: () => AudioNode | null,
    private apiKey?: string,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h['xi-api-key'] = this.apiKey;
    return h;
  }

  static async available(base = '/eleven', apiKey?: string): Promise<boolean> {
    try {
      const r = await fetch(`${base}/voices`, apiKey ? { headers: { 'xi-api-key': apiKey } } : undefined);
      // When the proxy isn't configured, the dev server returns index.html (200)
      // for this path — so require an actual JSON response, not the SPA fallback.
      return r.ok && (r.headers.get('content-type') ?? '').includes('application/json');
    } catch {
      return false;
    }
  }

  /** Fetch + decode speech to an AudioBuffer without playing it (for offline
   *  pre-render: synthesize the whole script, then play it back synced). */
  async synthesize(text: string, opts: SpeakOpts): Promise<AudioBuffer> {
    const ctx = this.getCtx ? this.getCtx() : (this.ctx ??= new AudioContext());
    const voiceId = opts.voiceId || '21m00Tcm4TlvDq8ikWAM';
    const res = await fetch(`${this.base}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  }

  async listVoices(): Promise<{ id: string; label: string }[]> {
    const r = await fetch(`${this.base}/voices`, { headers: this.headers() });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) return [];
    const data = (await r.json()) as { voices?: { voice_id: string; name: string }[] };
    return (data.voices ?? []).map((v) => ({ id: v.voice_id, label: v.name }));
  }

  speak(text: string, opts: SpeakOpts, hooks: SpeakHooks): SpeakHandle {
    const ctx = this.getCtx ? this.getCtx() : (this.ctx ??= new AudioContext());
    const controller = new AbortController();
    let src: AudioBufferSourceNode | null = null;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      hooks.onEnd?.();
      settle();
    };

    (async () => {
      try {
        const voiceId = opts.voiceId || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" default
        const res = await fetch(`${this.base}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: this.headers(true),
          body: JSON.stringify({
            text,
            model_id: MODEL_ID,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
        const buf = await res.arrayBuffer();
        if (controller.signal.aborted) return;
        const audio = await ctx.decodeAudioData(buf);
        if (controller.signal.aborted) return;

        src = ctx.createBufferSource();
        src.buffer = audio;
        const gain = ctx.createGain();
        src.connect(gain);
        gain.connect(ctx.destination); // speakers
        const tap = this.getTap?.();
        if (tap) gain.connect(tap); // also into the recording's audio stream
        hooks.onAudioNode?.(ctx, gain); // analyser lip-sync taps here
        hooks.onStart?.();
        src.onended = finish;
        await ctx.resume();
        src.start();
      } catch (err) {
        if (!controller.signal.aborted) hooks.onError?.(err);
        finish();
      }
    })();

    return {
      done,
      cancel: () => {
        controller.abort();
        try {
          src?.stop();
        } catch {
          /* already stopped */
        }
        finish();
      },
    };
  }
}
