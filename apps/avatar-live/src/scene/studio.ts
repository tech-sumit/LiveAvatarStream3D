import * as THREE from 'three';

/**
 * A PowerPoint-style wall slide: a kicker chip, a headline, a few bullets, the lower
 * ticker bar, and an optional backdrop image (cover-fit; falls back to a gradient when the
 * image is missing or not yet loaded). Structurally compatible with @las/protocol's
 * `SlideContent` — the studio is the renderer; the protocol carries the data.
 */
export type Slide = {
  kicker: string;
  headline: string;
  bullets: string[];
  ticker: string;
  image?: string;
};

// A procedural news-studio set built around an anchor standing at the origin
// (facing +Z, toward the camera). Everything is generated (no downloaded assets)
// so it works offline. Returned as one Group you can toggle with `.visible`.
export interface NewsStudio {
  group: THREE.Group;
  /** Paint a full slide (kicker / headline / bullets / ticker / optional image) on the wall. */
  setSlide(slide: Slide): void;
  /** Back-compat: set just a headline (+ kicker) — wraps setSlide with a derived ticker. */
  setHeadline(title: string, kicker?: string): void;
  /** Preload + cache slide backdrop images (by url) so setSlide never blocks on a fetch.
   *  Call before an export's frame loop so slides render with their imagery. */
  preloadSlideImages(urls: string[]): Promise<void>;
  /** Play a video element on the wall (its frames stream as the wall texture);
   *  pass null to revert to the canvas slide. */
  setScreenVideo(video: HTMLVideoElement | null): void;
  /** The wall mesh — used for camera framing and the "screen source" cut. */
  screen: THREE.Mesh;
}

/** Where the stand-mounted screen sits (anchor stands to its LEFT). Exported so the
 *  camera presets can frame the two-shot and the point gesture can aim at it. */
export const SCREEN_STAND_POS = new THREE.Vector3(1.95, 1.62, -0.35);

export function buildNewsStudio(): NewsStudio {
  const group = new THREE.Group();
  group.name = 'NewsStudio';

  // (Floor + the curved cyclorama backdrop / bright lighting are provided by the Stage so
  //  they persist when the studio set is hidden. This module builds the on-stage props:
  //  a stand-mounted screen to the anchor's RIGHT — an "anchor-left / screen-right" set.)

  // ── Stand-mounted video screen, to the anchor's right ───────────────────────
  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = 1024;
  screenCanvas.height = 576;
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  let videoTex: THREE.VideoTexture | null = null;

  const stand = new THREE.Group();
  stand.position.set(SCREEN_STAND_POS.x, 0, SCREEN_STAND_POS.z);
  stand.rotation.y = -0.42; // angle the screen toward the anchor + camera
  group.add(stand);

  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.35), screenMat);
  screen.position.set(0, SCREEN_STAND_POS.y, 0.012);
  stand.add(screen);
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(2.56, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x05080f, roughness: 0.5, metalness: 0.4 }),
  );
  bezel.position.set(0, SCREEN_STAND_POS.y, 0);
  stand.add(bezel);
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 0.045),
    new THREE.MeshBasicMaterial({ color: 0x2f6bff, toneMapped: false }),
  );
  strip.position.set(0, SCREEN_STAND_POS.y - 0.72, 0.013);
  stand.add(strip);
  // post + base
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1b2436, roughness: 0.4, metalness: 0.6 });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.14), standMat);
  post.position.set(0, 0.47, 0);
  post.castShadow = true;
  stand.add(post);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 0.08, 28), standMat);
  base.position.set(0, 0.04, 0);
  base.castShadow = true;
  base.receiveShadow = true;
  stand.add(base);

  // ── Ceiling light bars (emissive ambiance for wide shots) ──────────────────
  for (let i = -1; i <= 1; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.05, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xaebfe8, toneMapped: false }),
    );
    bar.position.set(i * 1.9 - 0.4, 3.5, -0.7);
    bar.rotation.x = 0.25;
    group.add(bar);
  }

  // Cache of preloaded slide backdrop images, keyed by url. Only successfully-loaded images
  // land here; setSlide falls back to the gradient for any url it can't find / that failed.
  const slideImages = new Map<string, HTMLImageElement>();

  async function preloadSlideImages(urls: string[]): Promise<void> {
    await Promise.all(
      urls
        .filter((u) => u && !slideImages.has(u))
        .map(
          (url) =>
            new Promise<void>((resolve) => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => {
                slideImages.set(url, img);
                resolve();
              };
              img.onerror = () => resolve(); // graceful: a failed image just uses the gradient
              img.src = url;
            }),
        ),
    );
  }

  function setSlide(slide: Slide): void {
    const cached = slide.image ? slideImages.get(slide.image) : undefined;
    const img = cached && cached.complete && cached.naturalWidth > 0 ? cached : null;
    drawSlide(screenCanvas, slide, img);
    screenTex.needsUpdate = true;
  }

  function setHeadline(title: string, kicker = 'LIVE'): void {
    setSlide({ kicker, headline: title, bullets: [], ticker: `${title.toUpperCase()}  ·  LIVE`, image: undefined });
  }
  setHeadline('LIVE AVATAR STREAM 3D', 'LIVE');

  function setScreenVideo(video: HTMLVideoElement | null): void {
    if (videoTex) {
      videoTex.dispose();
      videoTex = null;
    }
    if (video) {
      videoTex = new THREE.VideoTexture(video);
      videoTex.colorSpace = THREE.SRGBColorSpace;
      screenMat.map = videoTex;
    } else {
      screenMat.map = screenTex;
    }
    screenMat.needsUpdate = true;
  }

  return { group, setSlide, setHeadline, preloadSlideImages, setScreenVideo, screen };
}

// Draws a full wall slide: (a) backdrop = cover-fit image OR the dark gradient+grid fallback;
// (b) a left→right scrim over an image for text legibility; (c) the red kicker chip; (d) the
// wrapped headline; (e) up to 3 bullets; (f) the lower ticker bar (slide.ticker — never the old
// hardcoded string). Renders fully with NO image (graceful gradient fallback). Exported for the
// headless render smoke test — depends only on the passed canvas/context, no THREE / scene state.
export function drawSlide(canvas: HTMLCanvasElement, slide: Slide, image: HTMLImageElement | null): void {
  const c = canvas.getContext('2d');
  if (!c) return;
  const { width: w, height: h } = canvas;

  // (a) backdrop
  if (image) {
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight); // cover-fit
    const dw = image.naturalWidth * scale;
    const dh = image.naturalHeight * scale;
    c.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    // (b) left→right scrim so the text stays legible over the imagery
    const sc = c.createLinearGradient(0, 0, w, 0);
    sc.addColorStop(0, 'rgba(4,12,28,0.92)');
    sc.addColorStop(0.55, 'rgba(4,12,28,0.5)');
    sc.addColorStop(1, 'rgba(4,12,28,0.1)');
    c.fillStyle = sc;
    c.fillRect(0, 0, w, h);
  } else {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a1a3a');
    g.addColorStop(1, '#06101f');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(80,120,220,0.10)';
    c.lineWidth = 2;
    for (let x = 0; x < w; x += 64) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
  }

  // (c) kicker chip (red LIVE-style chip; text = slide.kicker)
  c.textBaseline = 'middle';
  c.font = 'bold 34px system-ui, sans-serif';
  const kicker = (slide.kicker || 'LIVE').toUpperCase();
  const chipW = Math.max(120, c.measureText(kicker).width + 48);
  c.fillStyle = '#ff3b3b';
  c.fillRect(60, 70, chipW, 56);
  c.fillStyle = '#fff';
  c.fillText(kicker, 84, 99);

  // (d) headline (wrapped, big)
  c.fillStyle = '#eaf0ff';
  c.font = 'bold 64px system-ui, sans-serif';
  c.textBaseline = 'alphabetic';
  let y = wrap(c, slide.headline.toUpperCase(), 60, 230, w - 120, 70, 3);

  // (e) up to 3 bullets
  c.font = '30px system-ui, sans-serif';
  y += 26;
  for (const bullet of slide.bullets.slice(0, 3)) {
    c.fillStyle = '#2f6bff';
    c.beginPath();
    c.arc(74, y - 10, 7, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#cfe0ff';
    y = wrap(c, bullet, 96, y, w - 160, 40, 2) + 12;
  }

  // (f) lower ticker bar (story-derived; the hardcoded-string bug is fixed)
  c.fillStyle = '#2f6bff';
  c.fillRect(0, h - 70, w, 70);
  c.fillStyle = '#fff';
  c.textBaseline = 'middle';
  c.font = '28px system-ui, sans-serif';
  c.fillText(slide.ticker, 30, h - 35);
}

// Word-wrap `text` from baseline y; returns the baseline y AFTER the last line (so bullets can
// flow below the headline). Stops after `maxLines` lines (truncating the rest).
function wrap(
  c: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lh: number,
  maxLines = Infinity,
): number {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line, x, yy);
      lines++;
      if (lines >= maxLines) return yy + lh;
      line = word;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) {
    c.fillText(line, x, yy);
    return yy + lh;
  }
  return yy;
}
