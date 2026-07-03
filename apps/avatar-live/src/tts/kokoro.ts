import { KokoroTTS } from 'kokoro-js';
import type { SpeakHandle, SpeakHooks, SpeakOpts, TtsSource } from './types.js';

// Kokoro-82M neural TTS, running entirely in the browser (kokoro-js /
// transformers.js → onnxruntime-web WASM). This is the FREE, no-key, no-credits
// default: it generates real PCM client-side, so — unlike Web Speech, whose audio
// can't be captured — it satisfies synthesize() and the MP4 export narration path.
// Playback goes through Web Audio so AudioAnalyserLipsync drives the mouth from the
// actual waveform, exactly like the ElevenLabs/server paths.
//
// Trade-off vs ElevenLabs: fixed preset voices (no cloning). Cloning stays on the
// ElevenLabs path (bring-your-own-key), which is now opt-in so it never auto-drains
// credits — see VoicePicker.
//
// The model (~90 MB at q8) downloads once on first use and is then cached by the
// browser (transformers.js Cache API), so subsequent loads are instant.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000; // Kokoro always emits mono @ 24 kHz.
// Kokoro renders quieter (measured peak ≈0.61) than ElevenLabs (peak ≈0.95), and the
// lip-sync jaw calibration (offlineLipsync / audioLipsync) is tuned to ElevenLabs'
// louder level — so un-normalized Kokoro barely opens the mouth. Peak-normalize each
// utterance to this target so the mouth (and the audio loudness) match.
const TARGET_PEAK = 0.95;

/** Scale `pcm` in place so its peak hits TARGET_PEAK (capped, silence-safe). */
function normalizePeak(pcm: Float32Array, target = TARGET_PEAK, maxGain = 12): void {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 1e-5) return; // effectively silent — don't amplify noise
  const gain = Math.min(maxGain, target / peak);
  if (Math.abs(gain - 1) < 1e-3) return;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
}

// ── Model-download progress broadcaster ──────────────────────────────────────
// The model (~90 MB) downloads once on first use. Subscribers (e.g. the studio's
// progress bar) get an aggregate 0..100 percentage plus a `done` flag.
export type KokoroProgress = (pct: number, done: boolean) => void;
const progressListeners = new Set<KokoroProgress>();
let lastPct = 0;
let modelReady = false;
function emitProgress(pct: number, done: boolean): void {
  lastPct = pct;
  if (done) modelReady = true;
  for (const l of progressListeners) l(pct, done);
}
/** Subscribe to Kokoro model-download progress. Immediately replays current state.
 *  Returns an unsubscribe fn. */
export function subscribeKokoroProgress(l: KokoroProgress): () => void {
  progressListeners.add(l);
  l(modelReady ? 100 : lastPct, modelReady);
  return () => progressListeners.delete(l);
}

// A friendly subset of Kokoro's voices (a=American, b=British, f=female, m=male).
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (US ♀)' },
  { id: 'af_bella', label: 'Bella (US ♀)' },
  { id: 'af_nicole', label: 'Nicole (US ♀)' },
  { id: 'am_michael', label: 'Michael (US ♂)' },
  { id: 'am_adam', label: 'Adam (US ♂)' },
  { id: 'am_onyx', label: 'Onyx (US ♂)' },
  { id: 'bf_emma', label: 'Emma (UK ♀)' },
  { id: 'bf_isabella', label: 'Isabella (UK ♀)' },
  { id: 'bm_george', label: 'George (UK ♂)' },
];
const DEFAULT_VOICE = 'af_heart';

// Module-level singleton: one model instance shared by every KokoroTts, loaded at
// most once (concurrent callers await the same promise).
let modelPromise: Promise<KokoroTTS> | null = null;
function loadModel(onStatus?: (msg: string) => void): Promise<KokoroTTS> {
  if (!modelPromise) {
    onStatus?.('voice: loading Kokoro model (first use downloads ~90 MB, then cached)…');
    // Aggregate byte progress across the model's files into one 0..100 bar.
    const fileBytes = new Map<string, { loaded: number; total: number }>();
    modelPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8',
      device: 'wasm', // WebGPU is unreliable for this model; WASM (single-thread) is portable.
      progress_callback: (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (e.file && typeof e.total === 'number' && e.total > 0) {
          fileBytes.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
          let loaded = 0;
          let total = 0;
          for (const v of fileBytes.values()) {
            loaded += v.loaded;
            total += v.total;
          }
          // Cap at 99 until the model is actually ready (final init after the bytes land).
          emitProgress(total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0, false);
        }
      },
    } as Parameters<typeof KokoroTTS.from_pretrained>[1]).then((m) => {
      emitProgress(100, true);
      onStatus?.('voice: Kokoro ready (free, in-browser TTS — MP4 export enabled)');
      return m;
    });
    // A failed load must not poison the singleton forever — let the next call retry.
    modelPromise.catch(() => {
      modelPromise = null;
      lastPct = 0;
    });
  }
  return modelPromise;
}

export class KokoroTts implements TtsSource {
  readonly kind = 'kokoro' as const;
  private ctx: AudioContext | null = null;

  /**
   * @param getCtx    optional shared AudioContext (so its output can be recorded / kept in sync)
   * @param getTap    optional extra node to also route audio into (e.g. a
   *                  MediaStreamAudioDestinationNode for capturing voice in clips)
   * @param onStatus  optional progress/status sink (wired to the studio log)
   */
  constructor(
    private getCtx?: () => AudioContext,
    private getTap?: () => AudioNode | null,
    private onStatus?: (msg: string) => void,
  ) {}

  private context(): AudioContext {
    return this.getCtx ? this.getCtx() : (this.ctx ??= new AudioContext());
  }

  /** Generate mono PCM for `text` and wrap it in an AudioBuffer on `ctx`. */
  private async render(text: string, opts: SpeakOpts, ctx: BaseAudioContext): Promise<AudioBuffer> {
    const model = await loadModel(this.onStatus);
    const voice = opts.voiceId && KOKORO_VOICES.some((v) => v.id === opts.voiceId) ? opts.voiceId : DEFAULT_VOICE;
    // `speed` maps the studio's rate slider; Kokoro clamps internally. Cast past the
    // voice literal-union param type (the id set is validated above).
    const raw = await model.generate(text, { voice: voice as never, speed: opts.rate || 1 });
    // Copy into a plain ArrayBuffer-backed Float32Array (kokoro-js's may ride a
    // SharedArrayBuffer, which copyToChannel's types reject).
    const pcm = new Float32Array(raw.audio as ArrayLike<number>);
    normalizePeak(pcm); // match ElevenLabs loudness so lip-sync clears its jaw gate
    // Kokoro's native rate (24 kHz) rides on the buffer; the offline mixdown and live
    // buffer sources resample to their own ctx rate automatically when played.
    const buffer = ctx.createBuffer(1, pcm.length, KOKORO_SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);
    return buffer;
  }

  /** Kick off the model download (idempotent) so the progress bar can fill before the
   *  user hits Generate. Safe to call on provider selection; resolves when ready. */
  async warmup(): Promise<void> {
    await loadModel(this.onStatus);
  }

  /** Synthesize to an AudioBuffer without playing — the offline export narration path. */
  async synthesize(text: string, opts: SpeakOpts): Promise<AudioBuffer> {
    return this.render(text, opts, this.context());
  }

  async listVoices(): Promise<{ id: string; label: string }[]> {
    return KOKORO_VOICES;
  }

  speak(text: string, opts: SpeakOpts, hooks: SpeakHooks): SpeakHandle {
    const ctx = this.context();
    let cancelled = false;
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
        const audio = await this.render(text, opts, ctx);
        if (cancelled) return;

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
        if (!cancelled) hooks.onError?.(err);
        finish();
      }
    })();

    return {
      done,
      cancel: () => {
        cancelled = true;
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
