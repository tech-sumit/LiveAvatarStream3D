import type { SpeakHandle, SpeakHooks, SpeakOpts, TtsSource } from './types.js';

// Browser-native TTS. Zero backend, realtime, and exposes word-boundary events
// we feed to BoundaryLipsync. Voice quality varies by OS/browser; this is the
// instant-demo path. The cloned-voice path is ServerTts.
export class WebSpeechTts implements TtsSource {
  readonly kind = 'web-speech' as const;

  static supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  async listVoices(): Promise<{ id: string; label: string }[]> {
    const voices = await loadVoices();
    return voices.map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` }));
  }

  speak(text: string, opts: SpeakOpts, hooks: SpeakHooks): SpeakHandle {
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = opts.rate;
    utter.pitch = opts.pitch;
    if (opts.voiceId) {
      const v = synth.getVoices().find((vc) => vc.voiceURI === opts.voiceId);
      if (v) utter.voice = v;
    }

    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      hooks.onEnd?.();
      settle();
    };

    utter.onstart = () => hooks.onStart?.();
    utter.onend = finish;
    utter.onerror = (e) => {
      // 'interrupted'/'canceled' are expected on barge-in; don't treat as errors.
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err && err !== 'interrupted' && err !== 'canceled') hooks.onError?.(err);
      finish();
    };
    utter.onboundary = (e) => {
      if (e.name && e.name !== 'word') return;
      const word = wordAt(text, e.charIndex, (e as SpeechSynthesisEvent).charLength);
      if (word) hooks.onWord?.(word, performance.now());
    };

    synth.speak(utter);

    return {
      done,
      cancel: () => {
        utter.onend = null;
        utter.onboundary = null;
        synth.cancel();
        finish();
      },
    };
  }
}

function wordAt(text: string, charIndex: number, charLength?: number): string {
  if (charLength && charLength > 0) return text.slice(charIndex, charIndex + charLength).trim();
  const rest = text.slice(charIndex);
  const m = rest.match(/^\s*([^\s]+)/);
  return m ? m[1] : '';
}

// getVoices() is populated asynchronously on first load in some browsers.
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const have = synth.getVoices();
    if (have.length) return resolve(have);
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      resolve(synth.getVoices());
    };
    synth.onvoiceschanged = fire;
    setTimeout(fire, 500);
  });
}
