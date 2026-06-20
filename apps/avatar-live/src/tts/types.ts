// A TTS source turns text into speech and reports word timing so the lipsync
// engine can stay aligned. Web Speech (local, instant) and a server cloned-voice
// stream both implement this, so the session orchestrator is source-agnostic.
export interface SpeakOpts {
  voiceId?: string;
  rate: number;
  pitch: number;
}

export interface SpeakHooks {
  onStart?(): void;
  /** Fired as each word begins (word-boundary path). */
  onWord?(word: string, atMs: number): void;
  /**
   * For audio-stream sources: the audio graph node carrying speech, so an
   * AnalyserNode lipsync driver can attach. Fired once when playback starts.
   */
  onAudioNode?(ctx: AudioContext, node: AudioNode): void;
  onEnd?(): void;
  onError?(err: unknown): void;
}

export interface SpeakHandle {
  done: Promise<void>;
  cancel(): void;
}

export interface TtsSource {
  readonly kind: 'web-speech' | 'server';
  speak(text: string, opts: SpeakOpts, hooks: SpeakHooks): SpeakHandle;
  listVoices?(): Promise<{ id: string; label: string }[]>;
  /** Optional: synthesize to an AudioBuffer without playing (for synced render). */
  synthesize?(text: string, opts: SpeakOpts): Promise<AudioBuffer>;
}
