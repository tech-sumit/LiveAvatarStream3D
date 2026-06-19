import {
  Box3,
  CanvasTexture,
  Color,
  Euler,
  Mesh,
  MeshPhongMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Object3D,
} from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

/** Viseme weights for decal-based mouth (POC — no morph targets on Lee bust). */
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

const VISEME_CYCLE: DecalViseme[] = ['sil', 'aa', 'oh', 'ee', 'mm'];

function makeMouthTexture(color: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#00000000';
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = `#${new Color(color).getHexString()}`;
  ctx.beginPath();
  ctx.ellipse(32, 36, 22, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(32, 32, 16, 6, 0, 0, Math.PI);
  ctx.fill();
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * Projects a mouth decal onto a static head mesh (Lee Perry-Smith pattern from
 * three.js webgl_decals). Decal mesh is added to hostRoot (not headMesh child)
 * so DecalGeometry world-space vertices are not double-transformed.
 */
export class DecalLipsyncController {
  private headMesh: Mesh;
  private hostRoot: Object3D;
  private decal: Mesh | null = null;
  private mouthLocal = new Vector3();
  private mouthEuler = new Euler(0, 0, 0);
  private sizeBase = new Vector3(1, 1, 1);
  private phase = 0;
  private cycleIndex = 0;
  private active = false;
  private currentViseme: DecalViseme = 'sil';
  private diffuseTemplate: ReturnType<TextureLoader['load']> | null = null;

  constructor(headMesh: Mesh, hostRoot: Object3D, useSplatterTexture = false) {
    this.headMesh = headMesh;
    this.hostRoot = hostRoot;
    this.headMesh.updateMatrixWorld(true);

    const box = new Box3().setFromObject(headMesh);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());

    this.mouthLocal.set(center.x, box.min.y + size.y * 0.38, box.max.z - size.z * 0.02);
    this.mouthEuler.set(-0.15, 0, 0);
    this.sizeBase.set(size.x * 0.14, size.y * 0.06, size.z * 0.08);

    if (useSplatterTexture) {
      const loader = new TextureLoader();
      this.diffuseTemplate = loader.load('/avatars/decal-diffuse.png');
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

  isActive(): boolean {
    return this.active;
  }

  update(deltaS: number): void {
    if (!this.active) return;
    this.phase += deltaS;
    if (this.phase >= 0.12) {
      this.phase = 0;
      this.cycleIndex = (this.cycleIndex + 1) % VISEME_CYCLE.length;
      this.applyViseme(VISEME_CYCLE[this.cycleIndex]!);
    }
  }

  setJawOpen(t: number): void {
    if (!this.active) return;
    const v: DecalViseme = t < 0.15 ? 'sil' : t < 0.4 ? 'mm' : t < 0.65 ? 'oh' : 'aa';
    this.applyViseme(v, t);
  }

  private applyViseme(viseme: DecalViseme, jaw = 0.5): void {
    if (viseme === this.currentViseme && this.decal) return;
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
      map: this.diffuseTemplate ?? makeMouthTexture(VISEME_COLORS[viseme]),
      color: this.diffuseTemplate ? new Color(VISEME_COLORS[viseme]) : undefined,
    });

    this.headMesh.updateMatrixWorld(true);
    const geom = new DecalGeometry(this.headMesh, this.mouthLocal, this.mouthEuler, size);
    this.decal = new Mesh(geom, material);
    this.decal.renderOrder = 10;
    this.hostRoot.add(this.decal);
    // #region agent log
    fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'decalLipsync.ts:applyViseme',message:'decal applied',data:{viseme,vertexCount:geom.attributes.position?.count??0,hostRoot:this.hostRoot.type},timestamp:Date.now(),runId:'post-fix',hypothesisId:'decal-parent'})}).catch(()=>{});
    // #endregion
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

export type DecalLipsyncMap = Map<string, DecalLipsyncController>;

export function updateDecalLipsync(map: DecalLipsyncMap, deltaS: number): void {
  for (const c of map.values()) c.update(deltaS);
}
