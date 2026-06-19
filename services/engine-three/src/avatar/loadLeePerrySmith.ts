import { join } from 'node:path';
import {
  Box3,
  Color,
  Group,
  Mesh,
  MeshPhongMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFile } from 'node:fs/promises';
import { DecalLipsyncController } from './decalLipsync.js';

export async function loadLeePerrySmithHead(
  loader: GLTFLoader,
  assetsDir: string,
): Promise<{ root: Group; headMesh: Mesh; lipsync: DecalLipsyncController }> {
  const base = join(assetsDir, 'avatars', 'LeePerrySmith');
  const loaderTex = new TextureLoader();
  const [map, specularMap, normalMap, gltfBuf] = await Promise.all([
    loaderTex.loadAsync(`file://${join(base, 'Map-COL.jpg')}`),
    loaderTex.loadAsync(`file://${join(base, 'Map-SPEC.jpg')}`),
    loaderTex.loadAsync(`file://${join(base, 'Infinite-Level_02_Tangent_SmoothUV.jpg')}`),
    readFile(join(base, 'LeePerrySmith.glb')),
  ]);
  map.colorSpace = SRGBColorSpace;

  const gltf = await loader.parseAsync(
    gltfBuf.buffer.slice(gltfBuf.byteOffset, gltfBuf.byteOffset + gltfBuf.byteLength),
    join(base, 'LeePerrySmith.glb'),
  );

  let headMesh: Mesh | undefined;
  gltf.scene.traverse((obj) => {
    if (headMesh) return;
    if (obj instanceof Mesh && obj.geometry?.attributes?.position) headMesh = obj;
  });
  if (!headMesh) throw new Error('LeePerrySmith.glb: no mesh found');

  headMesh.material = new MeshPhongMaterial({
    specular: 0x111111,
    map,
    specularMap,
    normalMap,
    shininess: 25,
  });

  const root = new Group();
  root.add(gltf.scene);
  root.scale.multiplyScalar(10);
  root.userData.layoutScale = 10;

  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  root.position.y -= box.min.y;

  const diffusePath = `file://${join(assetsDir, 'avatars', 'decal-diffuse.png')}`;
  const lipsync = new DecalLipsyncController(headMesh, root, diffusePath);

  return { root, headMesh, lipsync };
}
