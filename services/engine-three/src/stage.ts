import {
  AmbientLight,
  Color,
  DirectionalLight,
  EquirectangularReflectionMapping,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';

export async function buildStage(
  cfg: Config,
  scene: Scene,
  lighting: string,
): Promise<void> {
  scene.background = new Color(0x1a2030);

  const hdrPath = join(cfg.assetsDir, 'stage', 'studio.hdr');
  if (existsSync(hdrPath) && lighting !== 'flat_demo') {
    try {
      const loader = new RGBELoader();
      const tex = await loader.loadAsync(`file://${hdrPath}`);
      tex.mapping = EquirectangularReflectionMapping;
      scene.environment = tex;
    } catch {
      // HDRI optional
    }
  }

  applyLighting(scene, lighting);

  const floor = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshBasicMaterial({ color: 0x2a3040 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
}

function applyLighting(scene: Scene, preset: string): void {
  if (preset === 'flat_demo') {
    scene.add(new AmbientLight(0xffffff, 0.9));
    scene.add(new HemisphereLight(0xffffff, 0x444444, 0.5));
    return;
  }

  scene.add(new AmbientLight(0xffffff, 0.85));
  const hemi = new HemisphereLight(0xffffff, 0x444466, 0.55);
  scene.add(hemi);

  const warm = preset.includes('warm');
  const key = new DirectionalLight(warm ? 0xffe8d0 : 0xd0e8ff, 1.4);
  key.position.set(2.5, 4, 3);
  scene.add(key);

  const fill = new DirectionalLight(warm ? 0xc8d8ff : 0xffd8c8, 0.55);
  fill.position.set(-2, 2.5, 2);
  scene.add(fill);

  const rim = new DirectionalLight(0xffffff, 0.75);
  rim.position.set(0, 3, -3);
  scene.add(rim);
}
