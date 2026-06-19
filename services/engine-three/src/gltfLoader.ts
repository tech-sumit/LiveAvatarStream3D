import { Image as CanvasImage } from 'canvas';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Node lacks browser globals GLTFLoader texture paths expect. */
function ensureBrowserGlobals(): void {
  if (typeof globalThis.self === 'undefined') {
    (globalThis as { self?: typeof globalThis }).self = globalThis;
  }
  if (typeof globalThis.Image === 'undefined') {
    (globalThis as Record<string, unknown>).Image = CanvasImage;
  }
}

let loaderReady: Promise<GLTFLoader> | null = null;

/** Shared GLTFLoader with meshopt + Node globals for headless rendering. */
export async function createGltfLoader(): Promise<GLTFLoader> {
  if (!loaderReady) {
    loaderReady = (async () => {
      ensureBrowserGlobals();
      const loader = new GLTFLoader();
      await MeshoptDecoder.ready;
      loader.setMeshoptDecoder(MeshoptDecoder);
      return loader;
    })();
  }
  return loaderReady;
}
