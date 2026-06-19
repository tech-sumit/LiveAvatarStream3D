import type { SceneDocument, SceneNode, Transform } from '@las/protocol';
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
} from 'three';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGltfLoader } from './gltfLoader.js';
import type { Config } from './config.js';
import type { AvatarRig } from './avatar/loadAvatar.js';
import { R2Client } from './r2.js';

const ASSETS_BUCKET = process.env.R2_ASSETS_BUCKET ?? 'las-assets';

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function applyTransform(obj: Object3D, t: Transform): void {
  const layout = (obj.userData.layoutScale as number | undefined) ?? 1;
  obj.position.set(t.position[0], t.position[1], t.position[2]);
  obj.rotation.set(degToRad(t.rotation[0]), degToRad(t.rotation[1]), degToRad(t.rotation[2]));
  obj.scale.set(t.scale[0] * layout, t.scale[1] * layout, t.scale[2] * layout);
}

function syncCameraFromNode(
  camera: PerspectiveCamera,
  node: Extract<SceneNode, { type: 'camera' }>,
  aspect: number,
): void {
  camera.fov = node.fov;
  camera.near = node.near;
  camera.far = node.far;
  camera.aspect = aspect;
  applyTransform(camera, node.transform);
  camera.updateProjectionMatrix();
}

function buildFloorMesh(): Mesh {
  const m = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshStandardMaterial({ color: 0x2a3040, side: DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

function buildPropPlaceholder(): Mesh {
  return new Mesh(
    new BoxGeometry(0.5, 0.5, 0.5),
    new MeshStandardMaterial({ color: 0x8899aa }),
  );
}

async function loadPropGlb(path: string): Promise<Object3D> {
  const loader = await createGltfLoader();
  const buf = await readFile(path);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    path,
  );
  return gltf.scene;
}

/**
 * Apply the editor scene graph to a Three.js scene and return the active render camera.
 * Matches apps/scene-editor Viewport.tsx layout semantics.
 */
export async function setupEditorScene(opts: {
  cfg: Config;
  doc: SceneDocument;
  threeScene: Scene;
  avatar: AvatarRig;
  camera: PerspectiveCamera;
  aspect: number;
  workDir: string;
  r2: R2Client;
}): Promise<void> {
  const { doc, threeScene, avatar, camera, aspect, workDir, r2 } = opts;
  threeScene.background = new Color(doc.stage.background);

  let hasLights = false;
  const propsDir = join(workDir, 'props');

  for (const node of doc.nodes) {
    if (!node.visible) continue;

    if (node.type === 'avatar') {
      applyTransform(avatar.root, node.transform);
      continue;
    }

    if (node.type === 'light') {
      hasLights = true;
      const col = new Color(node.color);
      let light: AmbientLight | DirectionalLight | HemisphereLight | PointLight;
      switch (node.lightType) {
        case 'ambient':
          light = new AmbientLight(col, node.intensity);
          break;
        case 'hemisphere':
          light = new HemisphereLight(col, 0x444444, node.intensity);
          break;
        case 'point':
          light = new PointLight(col, node.intensity);
          break;
        default:
          light = new DirectionalLight(col, node.intensity);
      }
      applyTransform(light, node.transform);
      threeScene.add(light);
      continue;
    }

    if (node.type === 'prop') {
      let visual: Object3D;
      if (node.assetKey === '__builtin_floor__') {
        visual = buildFloorMesh();
      } else if (node.assetKey.startsWith('local/')) {
        visual = buildPropPlaceholder();
      } else {
        try {
          const localPath = join(propsDir, `${node.id}.glb`);
          await r2.download(ASSETS_BUCKET, node.assetKey, localPath);
          visual = await loadPropGlb(localPath);
        } catch {
          visual = buildPropPlaceholder();
        }
      }
      applyTransform(visual, node.transform);
      threeScene.add(visual);
      continue;
    }

    if (node.type === 'camera' && node.id === doc.activeCameraId) {
      syncCameraFromNode(camera, node, aspect);
    }
  }

  if (!hasLights) {
    threeScene.add(new AmbientLight(0xffffff, 0.35));
    const key = new DirectionalLight(0xffe8d0, 1.4);
    key.position.set(2.5, 4, 3);
    threeScene.add(key);
  }

  // Ensure active camera exists even if node missing.
  const camNode = doc.nodes.find(
    (n): n is Extract<SceneNode, { type: 'camera' }> =>
      n.type === 'camera' && n.id === doc.activeCameraId,
  );
  if (camNode) {
    syncCameraFromNode(camera, camNode, aspect);
  }
  camera.updateMatrixWorld(true);
}
