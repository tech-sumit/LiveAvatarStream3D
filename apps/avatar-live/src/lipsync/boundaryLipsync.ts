import type { MouthCue } from '../avatar/avatarController.js';

// Lipsync for TTS engines that expose word-boundary events but no routable audio
// (the Web Speech API on most browsers). On each word we synthesize a short
// sequence of mouth shapes from its letters and play them across the word's
// estimated duration, enveloped so the mouth closes between words. It's an
// approximation — not amplitude-accurate — but reads convincingly for reading a
// script, and needs no backend. For real cloned-voice audio use AudioAnalyserLipsync.
type Shape = MouthCue;

const SILENT: Shape = { jawOpen: 0, mouthWide: 0, mouthRound: 0, mouthClose: 0 };

export class BoundaryLipsync {
  private shapes: Shape[] = [];
  private wordStart = 0;
  private wordDur = 0;
  private rate = 1;

  constructor(rate = 1) {
    this.rate = rate;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  /** Call from the TTS 'boundary' event with the word about to be spoken. */
  noteWord(word: string, nowMs: number): void {
    const shapes = lettersToShapes(word);
    this.shapes = shapes.length ? shapes : [SILENT];
    this.wordStart = nowMs;
    const letters = (word.match(/[a-z]/gi) ?? []).length || word.length;
    this.wordDur = clamp((0.18 + 0.05 * letters) / this.rate, 0.12, 1.4) * 1000;
  }

  stop(): void {
    this.shapes = [];
  }

  /** Polled every render frame; returns the mouth shape for `nowMs`. */
  sample(nowMs: number): MouthCue {
    if (!this.shapes.length) return SILENT;
    const elapsed = nowMs - this.wordStart;
    const progress = elapsed / this.wordDur;
    if (progress >= 1) {
      // Word finished; relax toward closed until the next boundary.
      const over = (elapsed - this.wordDur) / 120;
      if (over >= 1) return SILENT;
      return scale(this.shapes[this.shapes.length - 1], 1 - over);
    }
    const pos = progress * this.shapes.length;
    const i = Math.min(this.shapes.length - 1, Math.floor(pos));
    const next = Math.min(this.shapes.length - 1, i + 1);
    const frac = pos - i;
    return scale(lerp(this.shapes[i], this.shapes[next], frac), envelope(progress));
  }
}

// Map a word to a sequence of mouth shapes, one per phoneme-ish letter group.
function lettersToShapes(word: string): Shape[] {
  const out: Shape[] = [];
  let prev = '';
  for (const ch of word.toLowerCase()) {
    const s = charShape(ch);
    if (!s) continue;
    // Collapse immediate repeats (e.g. "ee", "ll") into one held shape.
    if (ch === prev) continue;
    prev = ch;
    out.push(s);
  }
  return out;
}

function charShape(ch: string): Shape | null {
  switch (ch) {
    case 'a':
      return { jawOpen: 0.7, mouthWide: 0.15, mouthRound: 0, mouthClose: 0 };
    case 'e':
      return { jawOpen: 0.4, mouthWide: 0.7, mouthRound: 0, mouthClose: 0 };
    case 'i':
    case 'y':
      return { jawOpen: 0.25, mouthWide: 0.85, mouthRound: 0, mouthClose: 0 };
    case 'o':
      return { jawOpen: 0.55, mouthWide: 0, mouthRound: 0.7, mouthClose: 0 };
    case 'u':
    case 'w':
      return { jawOpen: 0.3, mouthWide: 0, mouthRound: 0.85, mouthClose: 0 };
    case 'm':
    case 'b':
    case 'p':
      return { jawOpen: 0.04, mouthWide: 0, mouthRound: 0, mouthClose: 0.5 };
    case 'f':
    case 'v':
      return { jawOpen: 0.12, mouthWide: 0.2, mouthRound: 0, mouthClose: 0.3 };
    default:
      // generic consonant — let the jaw carry it; no forced lip closure.
      if (/[a-z]/.test(ch)) return { jawOpen: 0.26, mouthWide: 0.18, mouthRound: 0.05, mouthClose: 0 };
      return null;
  }
}

function envelope(p: number): number {
  // Swell in and settle out across the word, with a sustained middle so the
  // mouth stays active rather than only opening at the midpoint.
  const c = Math.min(Math.max(p, 0), 1);
  return 0.55 + 0.45 * Math.sin(c * Math.PI);
}

function lerp(a: Shape, b: Shape, t: number): Shape {
  return {
    jawOpen: a.jawOpen + (b.jawOpen - a.jawOpen) * t,
    mouthWide: a.mouthWide + (b.mouthWide - a.mouthWide) * t,
    mouthRound: a.mouthRound + (b.mouthRound - a.mouthRound) * t,
    mouthClose: a.mouthClose + (b.mouthClose - a.mouthClose) * t,
  };
}

function scale(s: Shape, k: number): Shape {
  return {
    jawOpen: s.jawOpen * k,
    mouthWide: s.mouthWide * k,
    mouthRound: s.mouthRound * k,
    mouthClose: s.mouthClose * k,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
