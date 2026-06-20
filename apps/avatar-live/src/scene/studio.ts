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

export function buildNewsStudio(): NewsStudio {
  const group = new THREE.Group();
  group.name = 'NewsStudio';

  // (Floor is provided by the Stage so it persists when the studio is hidden.)

  // ── Curved backdrop wall behind the anchor ──────────────────────────────────
  const backdrop = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 5, 6, 48, 1, true, Math.PI * 0.75, Math.PI * 1.5),
    new THREE.MeshStandardMaterial({ color: 0x10182b, roughness: 0.9, side: THREE.BackSide }),
  );
  backdrop.position.set(0, 3, -1.2);
  backdrop.receiveShadow = true;
  group.add(backdrop);

  // ── Big video wall (emissive, canvas headline) ──────────────────────────────
  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = 1024;
  screenCanvas.height = 576;
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.36), screenMat);
  screen.position.set(0, 1.95, -2.55);
  group.add(screen);
  let videoTex: THREE.VideoTexture | null = null;
  // thin bezel
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 2.56),
    new THREE.MeshStandardMaterial({ color: 0x05080f, roughness: 0.6 }),
  );
  bezel.position.set(0, 1.95, -2.57);
  group.add(bezel);

  // ── Two angled accent side panels with glowing edge strips ─────────────────
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 3.4),
      new THREE.MeshStandardMaterial({ color: 0x121c30, roughness: 0.85, side: THREE.DoubleSide }),
    );
    panel.position.set(side * 3.1, 1.7, -1.6);
    panel.rotation.y = side * -0.5;
    group.add(panel);

    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(0.06, 3.4),
      new THREE.MeshBasicMaterial({ color: 0x2f6bff, toneMapped: false }),
    );
    strip.position.set(side * 2.0, 1.7, -1.55);
    strip.rotation.y = side * -0.5;
    group.add(strip);
  }

  // ── Anchor desk in front of the avatar ──────────────────────────────────────
  const desk = new THREE.Group();
  const deskBody = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 1.0, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x16203a, roughness: 0.5, metalness: 0.3 }),
  );
  deskBody.position.y = 0.5;
  deskBody.castShadow = true;
  deskBody.receiveShadow = true;
  desk.add(deskBody);
  const deskTop = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.06, 0.8),
    new THREE.MeshStandardMaterial({ color: 0x0c1322, roughness: 0.25, metalness: 0.6 }),
  );
  deskTop.position.y = 1.0;
  desk.add(deskTop);
  // glowing front accent
  const deskGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 0.12),
    new THREE.MeshBasicMaterial({ color: 0x2f6bff, toneMapped: false }),
  );
  deskGlow.position.set(0, 0.62, 0.351);
  desk.add(deskGlow);
  desk.position.set(0, 0, 0.75); // just in front of the anchor
  group.add(desk);

  // ── Ceiling light bars (emissive, for ambiance in wide shots) ──────────────
  for (let i = -1; i <= 1; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.05, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x6f86c9, toneMapped: false }),
    );
    bar.position.set(i * 1.7, 3.4, -0.5);
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
