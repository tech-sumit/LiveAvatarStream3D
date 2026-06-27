import { describe, it, expect } from 'vitest';
import { drawSlide, type Slide } from './studio.js';

// The studio's real wall paint is browser-only (a 2D canvas → a THREE.CanvasTexture). Here we
// exercise the PURE drawSlide path against a stub 2D context to prove it renders fully with NO
// image (the graceful gradient fallback) and with bullets / an image, without throwing — the
// headless half of the "slides MUST render with no image" guarantee.
function stubCanvas(w = 1024, h = 576): HTMLCanvasElement {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '',
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    fillText: () => {},
    measureText: (t: string) => ({ width: t.length * 12 }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
    drawImage: () => {},
  };
  return { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe('studio.drawSlide — headless render smoke (the browser does the real paint)', () => {
  it('renders a slide with NO image (gradient fallback) + extra bullets without throwing', () => {
    const slide: Slide = {
      kicker: 'LIVE',
      headline: 'Breaking news tonight on the anchor desk',
      bullets: ['Alpha point', 'Beta point', 'Gamma point', 'Dropped fourth'],
      ticker: 'BREAKING NEWS  ·  LIVE',
    };
    expect(() => drawSlide(stubCanvas(), slide, null)).not.toThrow();
  });

  it('renders with an image (cover-fit + scrim) without throwing', () => {
    const slide: Slide = { kicker: 'LIVE', headline: 'Markets', bullets: [], ticker: 'MARKETS  ·  LIVE' };
    const img = { naturalWidth: 800, naturalHeight: 450, complete: true } as unknown as HTMLImageElement;
    expect(() => drawSlide(stubCanvas(), slide, img)).not.toThrow();
  });
});
