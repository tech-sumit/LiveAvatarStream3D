import type { SpeakHandle, SpeakHooks, SpeakOpts, TtsSource } from './types.js';

// Cloned-voice path: POST text to a server TTS endpoint, decode the returned
// audio, and play it through Web Audio so AudioAnalyserLipsync can read the
// actual waveform. Set VITE_TTS_URL to a route that accepts { text, voiceId }
// and responds with audio bytes (wav/mp3). This is the production-quality path;
// it requires a deployed backend (see docs/specs — a `POST /api/tts` route).
export class ServerTts implements TtsSource {
  readonly kind = 'server' as const;
  private ctx: AudioContext | null = null;

  constructor(private endpoint: string) {}

  speak(text: string, opts: SpeakOpts, hooks: SpeakHooks): SpeakHandle {
    const ctx = (this.ctx ??= new AudioContext());
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
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voiceId: opts.voiceId }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const buf = await res.arrayBuffer();
        if (controller.signal.aborted) return;
        const audio = await ctx.decodeAudioData(buf);
        if (controller.signal.aborted) return;

        src = ctx.createBufferSource();
        src.buffer = audio;
        const gain = ctx.createGain();
        src.connect(gain).connect(ctx.destination);
        hooks.onAudioNode?.(ctx, gain);
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
