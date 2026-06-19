import {
  AnimationMixer,
  Box3,
  Group,
  LoopRepeat,
  Vector3,
  type AnimationClip,
} from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  AVATAR_PREVIEW_FALLBACK_ID,
  getAvatarEntry,
  resolveAvatarUrl,
} from './avatars.js';
import { loadLeePerrySmithHead } from './loadLeePerrySmith.js';
import type { DecalLipsyncController } from './decalLipsync.js';

function normalizeAvatarRoot(root: Group, targetHeightM = 1.75): void {
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  if (size.y <= 0) return;
  const layoutScale = targetHeightM / size.y;
  root.scale.setScalar(layoutScale);
  root.userData.layoutScale = layoutScale;
  root.updateMatrixWorld(true);
  const grounded = new Box3().setFromObject(root);
  root.position.y -= grounded.min.y;
}

export type AvatarMixerMap = Map<string, AnimationMixer>;
export type AvatarDecalMap = Map<string, DecalLipsyncController>;

export function updateAvatarMixers(mixers: AvatarMixerMap, deltaS: number): void {
  for (const m of mixers.values()) m.update(deltaS);
}

export async function loadAvatarPreview(
  loader: GLTFLoader,
  avatarId: string,
  cache: Map<string, { scene: Group; animations: AnimationClip[] }>,
): Promise<{ root: Group; mixer: AnimationMixer | null; lipsync: DecalLipsyncController | null }> {
  if (avatarId === 'lee_perry_smith') {
    const { root, lipsync } = await loadLeePerrySmithHead(loader);
    return { root, mixer: null, lipsync };
  }

  const tryIds = avatarId === 'ada' ? [avatarId, AVATAR_PREVIEW_FALLBACK_ID] : [avatarId];

  for (const id of tryIds) {
    if (cache.has(id)) {
      const hit = cache.get(id)!;
      const root = hit.scene.clone(true);
      normalizeAvatarRoot(root);
      const mixer = hit.animations.length > 0 ? new AnimationMixer(root) : null;
      if (mixer) {
        const clip =
          hit.animations.find((a) => /idle|stand|tpose|t-pose/i.test(a.name)) ?? hit.animations[0];
        if (clip) mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
      }
      return { root, mixer, lipsync: null };
    }

    const url = resolveAvatarUrl(id);
    try {
      const gltf = await loader.loadAsync(url);
      const scene = gltf.scene as Group;
      cache.set(id, { scene, animations: gltf.animations });
      const root = scene.clone(true);
      normalizeAvatarRoot(root);
      const mixer = gltf.animations.length > 0 ? new AnimationMixer(root) : null;
      if (mixer) {
        const clip =
          gltf.animations.find((a) => /idle|stand|tpose|t-pose/i.test(a.name)) ??
          gltf.animations[0];
        if (clip) mixer.clipAction(clip).reset().setLoop(LoopRepeat, Infinity).play();
      }
      if (id !== avatarId) {
        root.userData.previewFallback = getAvatarEntry(id).label;
      }
      return { root, mixer, lipsync: null };
    } catch {
      continue;
    }
  }

  throw new Error(`avatar ${avatarId} not found`);
}
