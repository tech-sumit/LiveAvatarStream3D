/**
 * Newsroom MCP — broadcast-card renderer (task NM-7, Phase 2).
 *
 * A parametric node-canvas renderer ported from the proven `/tmp/make-cards.js`
 * generator. Produces 1920x1080 dark-navy broadcast graphics for the studio
 * back-wall: a colored "pill" kicker, a big headline, an accent underline, an
 * optional sub line, and a SUVI AI NEWS lower-third bar.
 *
 * Dependency-light: only `canvas`. Fonts are registered best-effort from common
 * macOS/Linux system locations; if none load we fall back to the canvas default
 * sans, so rendering never fails on a font.
 */

import { createCanvas, registerFont, type CanvasRenderingContext2D } from 'canvas';

// ---------------------------------------------------------------------------
// Theme + font.
// ---------------------------------------------------------------------------

const W = 1920;
const H = 1080;

const NAVY0 = '#0a1020';
const NAVY1 = '#0e1b33';
const BLUE = '#5b8cff';
const TEAL = '#3ad29f';
const RED = '#ff4d5e';
const INK = '#e9eefb';
const MUTE = '#8da2c8';

/** Map a friendly accent name to a hex color (passes hex through unchanged). */
function resolveColor(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  if (name.startsWith('#')) return name;
  switch (name.toLowerCase()) {
    case 'blue':
      return BLUE;
    case 'teal':
    case 'green':
      return TEAL;
    case 'red':
      return RED;
    case 'ink':
    case 'white':
      return INK;
    case 'mute':
    case 'grey':
    case 'gray':
      return MUTE;
    default:
      return fallback;
  }
}

let FONT = 'Helvetica, Arial, sans-serif';
let fontReady = false;

/** Register a display font once, best-effort, from common system locations. */
function ensureFont(): void {
  if (fontReady) return;
  fontReady = true;
  const candidates: Array<[string, string]> = [
    ['/System/Library/Fonts/Avenir Next.ttc', 'Display'],
    ['/System/Library/Fonts/HelveticaNeue.ttc', 'Display'],
    ['/Library/Fonts/Arial.ttf', 'Display'],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'Display'],
    ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 'Display'],
  ];
  for (const [file, family] of candidates) {
    try {
      registerFont(file, { family });
      FONT = `${family}, Helvetica, Arial, sans-serif`;
      return;
    } catch {
      // keep trying
    }
  }
  // No system font registered — leave the sane sans fallback in place.
}

// ---------------------------------------------------------------------------
// Drawing primitives (ported from make-cards.js).
// ---------------------------------------------------------------------------

function bg(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, NAVY1);
  g.addColorStop(1, NAVY0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // radial glow
  const r = ctx.createRadialGradient(W * 0.7, H * 0.32, 80, W * 0.7, H * 0.32, 900);
  r.addColorStop(0, 'rgba(91,140,255,0.20)');
  r.addColorStop(1, 'rgba(91,140,255,0)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
  // dot grid
  ctx.fillStyle = 'rgba(141,162,200,0.07)';
  for (let y = 70; y < H; y += 46) {
    for (let x = 70; x < W; x += 46) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, 7);
      ctx.fill();
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
): number {
  ctx.font = `700 30px ${FONT}`;
  const w = ctx.measureText(text).width + 64;
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, 50, 25);
  ctx.fill();
  ctx.fillStyle = '#08101f';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  ctx.arc(x + 30, y + 25, 8, 0, 7);
  ctx.fill();
  ctx.fillText(text, x + 50, y + 26);
  return w;
}

function lowerThirdBar(ctx: CanvasRenderingContext2D, kicker: string): void {
  ctx.fillStyle = 'rgba(8,16,31,0.85)';
  ctx.fillRect(0, H - 92, W, 92);
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, H - 92, 10, 92);
  ctx.font = `700 26px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText('SUVI  AI  NEWS', 50, H - 46);
  ctx.font = `400 24px ${FONT}`;
  ctx.fillStyle = MUTE;
  ctx.fillText(kicker, 360, H - 46);
}

/** Word-wrap `text` from (x,y), returning the y of the last line drawn. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  max: number,
  lh: number,
): number {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, yy);
  return yy;
}

// ---------------------------------------------------------------------------
// Public spec + renderer.
// ---------------------------------------------------------------------------

export type CardKind = 'title' | 'lower_third' | 'stat' | 'quote' | 'developing';

export interface CardSpec {
  /** Layout family. */
  kind: CardKind;
  /** Kicker pill text (e.g. "BREAKING"). Defaults derived from `kind`. */
  pill?: string;
  /** Pill color — a name ('blue'|'teal'|'red') or hex. */
  pillColor?: string;
  /** The big headline. */
  headline: string;
  /** Optional secondary line under the headline. */
  sub?: string;
  /** Optional lower-third kicker text (right of the SUVI AI NEWS label). */
  lowerThird?: string;
  /** Accent color for the underline — a name or hex. */
  accent?: string;
}

const DEFAULT_PILL: Record<CardKind, { text: string; color: string }> = {
  title: { text: 'BREAKING', color: RED },
  lower_third: { text: 'THE STORY', color: BLUE },
  stat: { text: 'BY THE NUMBERS', color: BLUE },
  quote: { text: 'IN THEIR WORDS', color: BLUE },
  developing: { text: 'DEVELOPING STORY', color: RED },
};

/**
 * Render a single broadcast card to a 1920x1080 PNG buffer.
 */
export function renderCard(spec: CardSpec): Buffer {
  ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  bg(ctx);

  const def = DEFAULT_PILL[spec.kind];
  const pillText = spec.pill ?? def.text;
  const pillColor = resolveColor(spec.pillColor, def.color);
  const accent = resolveColor(spec.accent, spec.kind === 'developing' ? BLUE : TEAL);
  const lt = spec.lowerThird ?? '';

  pill(ctx, 110, 150, pillText, pillColor);
  ctx.textBaseline = 'alphabetic';

  switch (spec.kind) {
    case 'title': {
      ctx.fillStyle = INK;
      ctx.font = `800 150px ${FONT}`;
      const lastY = wrap(ctx, spec.headline, 108, 400, 1700, 160);
      ctx.fillStyle = accent;
      ctx.fillRect(112, lastY + 36, 520, 8);
      if (spec.sub) {
        ctx.fillStyle = MUTE;
        ctx.font = `500 52px ${FONT}`;
        ctx.fillText(spec.sub, 112, lastY + 130);
      }
      break;
    }
    case 'lower_third': {
      ctx.fillStyle = INK;
      ctx.font = `800 120px ${FONT}`;
      const lastY = wrap(ctx, spec.headline, 108, 380, 1700, 132);
      ctx.fillStyle = accent;
      ctx.fillRect(112, lastY + 30, 380, 8);
      if (spec.sub) {
        ctx.fillStyle = INK;
        ctx.font = `500 60px ${FONT}`;
        wrap(ctx, spec.sub, 112, lastY + 130, 1500, 84);
      }
      break;
    }
    case 'stat': {
      ctx.fillStyle = accent === MUTE ? BLUE : accent;
      ctx.font = `800 110px ${FONT}`;
      const lastY = wrap(ctx, spec.headline, 108, 360, 1700, 120);
      if (spec.sub) {
        ctx.fillStyle = INK;
        ctx.font = `500 52px ${FONT}`;
        wrap(ctx, spec.sub, 112, lastY + 90, 1660, 70);
      }
      break;
    }
    case 'quote': {
      ctx.fillStyle = INK;
      ctx.font = `800 92px ${FONT}`;
      const headline = /["“”]/.test(spec.headline)
        ? spec.headline
        : `“${spec.headline}”`;
      const lastY = wrap(ctx, headline, 112, 430, 1660, 124);
      ctx.fillStyle = accent === TEAL ? BLUE : accent;
      ctx.fillRect(112, lastY + 50, 260, 8);
      if (spec.sub) {
        ctx.fillStyle = MUTE;
        ctx.font = `500 50px ${FONT}`;
        ctx.fillText(spec.sub.startsWith('—') ? spec.sub : `— ${spec.sub}`, 112, lastY + 150);
      }
      break;
    }
    case 'developing': {
      ctx.fillStyle = INK;
      ctx.font = `800 140px ${FONT}`;
      const lastY = wrap(ctx, spec.headline, 108, 500, 1700, 150);
      ctx.fillStyle = accent;
      ctx.fillRect(112, lastY + 40, 460, 8);
      if (spec.sub) {
        ctx.fillStyle = MUTE;
        ctx.font = `500 50px ${FONT}`;
        wrap(ctx, spec.sub, 112, lastY + 150, 1660, 68);
      }
      break;
    }
  }

  lowerThirdBar(ctx, lt);
  return canvas.toBuffer('image/png');
}
