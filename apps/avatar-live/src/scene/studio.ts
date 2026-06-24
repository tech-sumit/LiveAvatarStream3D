import * as THREE from 'three';

// A procedural news-studio set built around an anchor standing at the origin
// (facing +Z, toward the camera). Everything is generated (no downloaded assets)
// so it works offline. Returned as one Group you can toggle with `.visible`.
export interface NewsStudio {
  group: THREE.Group;
  /** Update the big video wall's headline text. */
  setHeadline(title: string, kicker?: string): void;
  /** Play a video element on the wall (its frames stream as the wall texture);
   *  pass null to revert to the canvas headline. */
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

  function setHeadline(title: string, kicker = 'LIVE'): void {
    drawScreen(screenCanvas, title, kicker);
    screenTex.needsUpdate = true;
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

  return { group, setHeadline, setScreenVideo, screen };
}

// Draws the video-wall content: dark gradient, red LIVE chip, headline, ticker.
function drawScreen(canvas: HTMLCanvasElement, title: string, kicker: string): void {
  const c = canvas.getContext('2d');
  if (!c) return;
  const { width: w, height: h } = canvas;
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0a1a3a');
  g.addColorStop(1, '#06101f');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  // subtle grid
  c.strokeStyle = 'rgba(80,120,220,0.10)';
  c.lineWidth = 2;
  for (let x = 0; x < w; x += 64) {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
  }

  // LIVE chip
  c.fillStyle = '#ff3b3b';
  c.fillRect(60, 70, 150, 56);
  c.fillStyle = '#fff';
  c.font = 'bold 34px system-ui, sans-serif';
  c.textBaseline = 'middle';
  c.fillText(kicker, 84, 99);

  // headline
  c.fillStyle = '#eaf0ff';
  c.font = 'bold 64px system-ui, sans-serif';
  wrap(c, title.toUpperCase(), 60, 230, w - 120, 70);

  // lower ticker bar
  c.fillStyle = '#2f6bff';
  c.fillRect(0, h - 70, w, 70);
  c.fillStyle = '#fff';
  c.font = '28px system-ui, sans-serif';
  c.fillText('BREAKING  ·  REALTIME 3D ANCHOR  ·  BROWSER-RENDERED  ·  LIP-SYNCED', 30, h - 35);
}

function wrap(c: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number): void {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line, x, yy);
      line = word;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) c.fillText(line, x, yy);
}
