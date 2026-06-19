import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let loaderReady: Promise<GLTFLoader> | null = null;

/** GLTFLoader with meshopt for ada.glb (VALID / meshopt-compressed assets). */
export async function createEditorGltfLoader(): Promise<GLTFLoader> {
  if (!loaderReady) {
    loaderReady = (async () => {
      const loader = new GLTFLoader();
      await MeshoptDecoder.ready;
      loader.setMeshoptDecoder(MeshoptDecoder);
      return loader;
    })();
  }
  return loaderReady;
}
