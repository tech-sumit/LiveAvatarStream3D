import { Box3, Group, Mesh, MeshPhongMaterial, SRGBColorSpace, TextureLoader, Vector3 } from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DecalLipsyncController } from './decalLipsync.js';

const LEE_BASE = '/avatars/LeePerrySmith';

/** Load Lee Perry-Smith bust with PBR-style maps (webgl_decals example). */
export async function loadLeePerrySmithHead(loader: GLTFLoader): Promise<{
  root: Group;
  headMesh: Mesh;
  lipsync: DecalLipsyncController;
}> {
  const loaderTex = new TextureLoader();
  const [map, specularMap, normalMap, gltf] = await Promise.all([
    loaderTex.loadAsync(`${LEE_BASE}/Map-COL.jpg`),
    loaderTex.loadAsync(`${LEE_BASE}/Map-SPEC.jpg`),
    loaderTex.loadAsync(`${LEE_BASE}/Infinite-Level_02_Tangent_SmoothUV.jpg`),
    loader.loadAsync(`${LEE_BASE}/LeePerrySmith.glb`),
  ]);
  map.colorSpace = SRGBColorSpace;

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

  const lipsync = new DecalLipsyncController(headMesh, root, true);

  return { root, headMesh, lipsync };
}
