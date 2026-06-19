import {
  Box3,
  Color,
  DataTexture,
  Euler,
  Mesh,
  MeshPhongMaterial,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector3,
  type Object3D,
} from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

export type DecalViseme = 'sil' | 'aa' | 'oh' | 'ee' | 'mm';

const VISEME_COLORS: Record<DecalViseme, number> = {
  sil: 0x884444,
  aa: 0xcc3333,
  oh: 0xcc6633,
  ee: 0x33aa66,
  mm: 0x4466aa,
};

const VISEME_SCALE: Record<DecalViseme, [number, number, number]> = {
  sil: [0.8, 0.35, 0.4],
  aa: [1.1, 1.4, 0.5],
  oh: [1.0, 1.0, 0.55],
  ee: [1.2, 0.5, 0.4],
  mm: [0.9, 0.25, 0.45],
};

const RHUBARB_TO_DECAL: Record<string, DecalViseme> = {
  A: 'aa',
  B: 'oh',
  C: 'ee',
  D: 'mm',
  E: 'sil',
  F: 'mm',
  G: 'oh',
  H: 'sil',
  X: 'sil',
};

function makeMouthDataTexture(color: number): DataTexture {
  const w = 64;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  const c = new Color(color);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - 32) / 22;
      const ny = (y - 36) / 14;
      const inside = nx * nx + ny * ny <= 1;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = inside ? 220 : 0;
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Decal-based mouth for static Lee Perry-Smith bust (headless-safe — no DOM canvas). */
export class DecalLipsyncController {
  private headMesh: Mesh;
  private hostRoot: Object3D;
  private decal: Mesh | null = null;
  private mouthLocal = new Vector3();
  private mouthEuler = new Euler(0, 0, 0);
  private sizeBase = new Vector3(1, 1, 1);
  private active = false;
  private currentViseme: DecalViseme = 'sil';
  private diffuseTemplate: ReturnType<TextureLoader['load']> | null = null;

  constructor(headMesh: Mesh, hostRoot: Object3D, diffusePath?: string) {
    this.headMesh = headMesh;
    this.hostRoot = hostRoot;
    this.headMesh.updateMatrixWorld(true);

    const box = new Box3().setFromObject(headMesh);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    this.mouthLocal.set(center.x, box.min.y + size.y * 0.38, box.max.z - size.z * 0.02);
    this.mouthEuler.set(-0.15, 0, 0);
    this.sizeBase.set(size.x * 0.14, size.y * 0.06, size.z * 0.08);

    if (diffusePath) {
      const loader = new TextureLoader();
      this.diffuseTemplate = loader.load(diffusePath);
      this.diffuseTemplate.colorSpace = SRGBColorSpace;
    }
  }

  setActive(on: boolean): void {
    this.active = on;
    if (!on) {
      this.removeDecal();
      this.currentViseme = 'sil';
    } else {
      this.applyViseme('aa');
    }
  }

  updateFromFrame(jawOpen: number, viseme?: string): void {
    if (!this.active) return;
    const mapped = viseme ? (RHUBARB_TO_DECAL[viseme.toUpperCase()] ?? 'aa') : undefined;
    if (mapped) {
      this.applyViseme(mapped, jawOpen);
      return;
    }
    const v: DecalViseme =
      jawOpen < 0.15 ? 'sil' : jawOpen < 0.4 ? 'mm' : jawOpen < 0.65 ? 'oh' : 'aa';
    this.applyViseme(v, jawOpen);
  }

  private applyViseme(viseme: DecalViseme, jaw = 0.5): void {
    this.currentViseme = viseme;
    this.removeDecal();

    const [sx, sy, sz] = VISEME_SCALE[viseme];
    const jawBoost = 0.5 + jaw * 0.5;
    const size = new Vector3(
      this.sizeBase.x * sx,
      this.sizeBase.y * sy * jawBoost,
      this.sizeBase.z * sz,
    );

    const material = new MeshPhongMaterial({
      specular: 0x444444,
      shininess: 30,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      map: this.diffuseTemplate ?? makeMouthDataTexture(VISEME_COLORS[viseme]),
      color: this.diffuseTemplate ? new Color(VISEME_COLORS[viseme]) : undefined,
    });

    const geom = new DecalGeometry(this.headMesh, this.mouthLocal, this.mouthEuler, size);
    this.decal = new Mesh(geom, material);
    this.decal.renderOrder = 10;
    this.hostRoot.add(this.decal);
  }

  private removeDecal(): void {
    if (!this.decal) return;
    this.hostRoot.remove(this.decal);
    this.decal.geometry.dispose();
    (this.decal.material as MeshPhongMaterial).dispose();
    this.decal = null;
  }

  dispose(): void {
    this.removeDecal();
  }
}
