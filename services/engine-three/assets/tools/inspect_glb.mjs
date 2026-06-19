#!/usr/bin/env node
/** List morph target names from a glTF binary. Usage: node inspect_glb.mjs path/to/model.glb */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const path = resolve(process.argv[2] ?? '');
if (!path) {
  console.error('Usage: node inspect_glb.mjs <model.glb>');
  process.exit(1);
}

const loader = new GLTFLoader();
const gltf = await loader.loadAsync(pathToFileURL(path).href);
gltf.scene.traverse((obj) => {
  const mesh = obj;
  if (!('isMesh' in mesh) || !mesh.isMesh || !mesh.morphTargetDictionary) return;
  console.log(`Mesh: ${mesh.name || '(unnamed)'}`);
  console.log('  morph targets:', Object.keys(mesh.morphTargetDictionary).join(', '));
});
