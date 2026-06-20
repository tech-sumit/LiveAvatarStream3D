import type { SpeakHandle, SpeakOpts, TtsSource } from '../tts/types.js';

// Sequences a script into spoken segments and plays them back-to-back in
// realtime. Text can be pushed up front (start) or streamed in live (enqueue) —
// the "stream the script" use case — and stop() barges in, cancelling the
// current utterance and clearing the queue. It is rendering-agnostic: it just
// fires word/segment hooks that the app wires to lipsync + the avatar.
export interface SessionHooks {
  onWord?(word: string, atMs: number): void;
  onAudioNode?(ctx: AudioContext, node: AudioNode): void;
  onSegmentStart?(text: string): void;
  onSegmentEnd?(): void;
  onIdle?(): void;
  onStatus?(msg: string): void;
}

export class RealtimeSession {
  private queue: string[] = [];
  private running = false;
  private current: SpeakHandle | null = null;
  private stopped = false;

  constructor(
    private tts: TtsSource,
    private getOpts: () => SpeakOpts,
    private hooks: SessionHooks,
  ) {}

  get speaking(): boolean {
    return this.running;
  }

  /** Queue a whole script (split into sentences) and begin speaking. */
  start(script: string): void {
    this.stopped = false;
    const segments = splitSentences(script);
    if (!segments.length) return;
    this.queue.push(...segments);
    this.hooks.onStatus?.(`queued ${segments.length} segment(s)`);
    void this.run();
  }

  /** Push one line in live while a session is active (or to start one). */
  enqueue(line: string): void {
    const segs = splitSentences(line);
    if (!segs.length) return;
    this.stopped = false;
    this.queue.push(...segs);
    void this.run();
  }

  /** Barge-in: stop now and drop anything queued. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.current?.cancel();
    this.current = null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const text = this.queue.shift()!;
        this.hooks.onSegmentStart?.(text);
        const handle = this.tts.speak(text, this.getOpts(), {
          onStart: () => this.hooks.onStatus?.(`speaking: "${truncate(text)}"`),
          onWord: this.hooks.onWord,
          onAudioNode: this.hooks.onAudioNode,
          onEnd: () => this.hooks.onSegmentEnd?.(),
          onError: (e) => this.hooks.onStatus?.(`tts error: ${String(e)}`),
        });
        this.current = handle;
        await handle.done;
        this.current = null;
      }
    } finally {
      this.running = false;
      if (!this.queue.length) this.hooks.onIdle?.();
    }
  }
}

// Split into speakable chunks on sentence punctuation, keeping it natural.
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
