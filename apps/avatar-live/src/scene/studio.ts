import * as THREE from 'three';

// A stylized, fully procedural news studio built around an anchor standing at the
// origin facing +Z (toward the camera). No external assets. Returns the group +
// setters so the UI can recolor the accent (light strips) and the video wall.
export interface Studio {
  group: THREE.Group;
  setAccent(hex: number): void;
  setScreen(hex: number): void;
}

export function createStudio(): Studio {
  const group = new THREE.Group();
  const accentMats: THREE.MeshBasicMaterial[] = [];

  // Floor — dark, slightly glossy.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x0c111c, roughness: 0.45, metalness: 0.5 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // Curved cyclorama wall enclosing the set.
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(7, 7, 7, 48, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x161d2e, roughness: 0.95, side: THREE.BackSide }),
  );
  wall.position.y = 3.4;
  wall.receiveShadow = true;
  group.add(wall);

  // Video wall behind the anchor (emissive panel + dark bezel).
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(5.0, 2.7),
    new THREE.MeshStandardMaterial({ color: 0x070b14, roughness: 0.6 }),
  );
  bezel.position.set(0, 1.75, -3.25);
  group.add(bezel);

  const screenTex = makeScreenTexture();
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x0a1228,
    map: screenTex,
    emissive: 0x6f9bff,
    emissiveMap: screenTex,
    emissiveIntensity: 0.85,
    roughness: 0.5,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.3), screenMat);
  screen.position.set(0, 1.75, -3.2);
  group.add(screen);

  // Vertical accent light strips flanking the screen.
  for (const x of [-3.1, 3.1]) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a6df0 });
    accentMats.push(mat);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 3.4, 0.07), mat);
    bar.position.set(x, 2.0, -2.7);
    group.add(bar);
  }
  // Horizontal accent strip across the floor in front of the backdrop.
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a6df0 });
    accentMats.push(mat);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.04, 0.06), mat);
    strip.position.set(0, 0.02, -2.0);
    group.add(strip);
  }

  // Anchor desk in front of the avatar (between it and the camera).
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x121826, roughness: 0.5, metalness: 0.3 });
  const deskTop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.62), deskMat);
  deskTop.position.set(0, 0.96, 0.62);
  deskTop.castShadow = true;
  deskTop.receiveShadow = true;
  group.add(deskTop);

  const deskFront = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.92, 0.06), deskMat);
  deskFront.position.set(0, 0.5, 0.92);
  group.add(deskFront);

  // Lit accent band on the desk front.
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a6df0 });
    accentMats.push(mat);
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.07, 0.07), mat);
    band.position.set(0, 0.74, 0.95);
    group.add(band);
  }

  return {
    group,
    setAccent(hex: number) {
      for (const m of accentMats) m.color.setHex(hex);
    },
    setScreen(hex: number) {
      screenMat.emissive.setHex(hex); // tints the gradient on the video wall
    },
  };
}

// A studio video-wall texture: vertical gradient + center glow + faint scanlines.
function makeScreenTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0a1730');
  grad.addColorStop(0.5, '#1b3a7a');
  grad.addColorStop(1, '#0a1730');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  const glow = g.createRadialGradient(256, 128, 20, 256, 128, 280);
  glow.addColorStop(0, 'rgba(120,170,255,0.4)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(120,160,255,0.06)';
  for (let y = 0; y < 256; y += 6) g.fillRect(0, y, 512, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
