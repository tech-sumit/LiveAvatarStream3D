import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  AnimationMixer,
  Box3,
  CylinderGeometry,
  Group,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PerformanceManifest } from '@las/protocol';
import type { Config } from '../config.js';
import { MontageController, loadRegistry, resolveAvatarPath } from '../body/montageLoader.js';
import { createGltfLoader } from '../gltfLoader.js';
import {
  applyMorphWeights,
  buildMorphIndex,
  ensurePlaceholderMorphs,
  loadMorphMap,
} from '../face/morphApply.js';
import type { MorphMapFile } from '../face/morphApply.js';
import { loadLeePerrySmithHead } from './loadLeePerrySmith.js';
import type { DecalLipsyncController } from './decalLipsync.js';

export interface AvatarRig {
  root: Group;
  mixer: AnimationMixer;
  montage: MontageController;
  proceduralMontages: boolean;
  faceMesh: Mesh | null;
  morphIndex: Record<string, number>;
  morphInfluences: number[];
  morphMap: MorphMapFile;
  head?: Mesh;
  torso?: Mesh;
  leftArm?: Mesh;
  rightArm?: Mesh;
  decalLipsync?: DecalLipsyncController;
}

export async function loadAvatar(cfg: Config, manifest: PerformanceManifest): Promise<AvatarRig> {
  const avatarId = manifest.stage.avatarId.replace(/^BP_/i, '').toLowerCase();
  const leePath = join(cfg.assetsDir, 'avatars', 'LeePerrySmith', 'LeePerrySmith.glb');
  if (avatarId === 'lee_perry_smith' && existsSync(leePath)) {
    return loadLeePerrySmithAvatar(cfg);
  }

  const registry = await loadRegistry(cfg.assetsDir);
  const entry = registry[avatarId] ?? registry.ada;
  if (!entry) throw new Error(`unknown avatar id: ${avatarId}`);
  const morphMap = await loadMorphMap(cfg.assetsDir, entry.morphMap);
  const glbPath = resolveAvatarPath(cfg, manifest.stage.avatarId);

  if (existsSync(glbPath)) {
    return loadGltfAvatar(cfg, glbPath, morphMap);
  }
  return buildPlaceholderAvatar(cfg, morphMap);
}

async function loadLeePerrySmithAvatar(cfg: Config): Promise<AvatarRig> {
  const morphMap = await loadMorphMap(cfg.assetsDir, 'arkit_default');
  const loader = await createGltfLoader();
  const { root, lipsync } = await loadLeePerrySmithHead(loader, cfg.assetsDir);
  const mixer = new AnimationMixer(root);
  const montage = await MontageController.load(cfg, mixer);
  lipsync.setActive(true);
  return {
    root,
    mixer,
    montage,
    proceduralMontages: false,
    faceMesh: null,
    morphIndex: {},
    morphInfluences: [],
    morphMap,
    decalLipsync: lipsync,
  };
}

async function loadGltfAvatar(
  cfg: Config,
  glbPath: string,
  morphMap: MorphMapFile,
): Promise<AvatarRig> {
  const loader = await createGltfLoader();
  const buf = await readFile(glbPath);
  const gltf = await loader.parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    glbPath,
  );
  const root = gltf.scene as Group;
  normalizeGltfAvatar(root, 1.75);

  const faceMesh = findMorphMesh(root);

  const mixer = new AnimationMixer(root);
  const montage = await MontageController.load(cfg, mixer);

  const idle =
    gltf.animations.find((a) => /idle|stand|tpose|t-pose/i.test(a.name)) ?? gltf.animations[0];
  if (idle) {
    mixer.clipAction(idle).reset().setLoop(LoopRepeat, Infinity).play();
  }

  return {
    root,
    mixer,
    montage,
    proceduralMontages: false,
    faceMesh,
    morphIndex: buildMorphIndex(faceMesh?.morphTargetDictionary),
    morphInfluences: faceMesh?.morphTargetInfluences ?? [],
    morphMap,
  };
}

function normalizeGltfAvatar(root: Group, targetHeightM: number): void {
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  if (size.y <= 0) return;
  const scale = targetHeightM / size.y;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const grounded = new Box3().setFromObject(root);
  root.position.x -= (grounded.min.x + grounded.max.x) / 2;
  root.position.z -= (grounded.min.z + grounded.max.z) / 2;
  root.position.y -= grounded.min.y;
}

function findMorphMesh(root: Group): Mesh | null {
  let result: Mesh | null = null;
  root.traverse((obj) => {
    if (result) return;
    if (!(obj instanceof Mesh)) return;
    if (obj.morphTargetDictionary && Object.keys(obj.morphTargetDictionary).length > 0) {
      result = obj;
    }
  });
  return result;
}

async function buildPlaceholderAvatar(cfg: Config, morphMap: MorphMapFile): Promise<AvatarRig> {
  const skin = new MeshBasicMaterial({ color: 0xe8c4a8 });
  const root = new Group();

  const torso = new Mesh(new CylinderGeometry(0.22, 0.28, 0.85, 16), skin);
  torso.position.y = 1.05;
  root.add(torso);

  const head = new Mesh(new SphereGeometry(0.17, 24, 24), skin.clone());
  head.position.y = 1.62;
  root.add(head);

  const armGeo = new CylinderGeometry(0.05, 0.05, 0.45, 8);
  const leftArm = new Mesh(armGeo, skin.clone());
  leftArm.position.set(-0.35, 1.15, 0);
  leftArm.rotation.z = 0.35;
  root.add(leftArm);

  const rightArm = new Mesh(armGeo, skin.clone());
  rightArm.position.set(0.35, 1.15, 0);
  rightArm.rotation.z = -0.35;
  root.add(rightArm);

  const morphIndex: Record<string, number> = {};
  const morphInfluences: number[] = [];
  ensurePlaceholderMorphs(morphIndex, morphInfluences, [
    'jawOpen',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthFrownLeft',
    'browInnerUp',
  ]);

  const mixer = new AnimationMixer(root);
  const montage = await MontageController.load(cfg, mixer);

  return {
    root,
    mixer,
    montage,
    proceduralMontages: true,
    faceMesh: head,
    morphIndex,
    morphInfluences,
    morphMap,
    head,
    torso,
    leftArm,
    rightArm,
  };
}

export function applyFaceToAvatar(
  avatar: AvatarRig,
  frame: { jawOpen: number; emotions: { [k: string]: number | undefined }; viseme?: string },
): void {
  if (avatar.decalLipsync) {
    avatar.decalLipsync.updateFromFrame(frame.jawOpen, frame.viseme);
    return;
  }

  const emotionEntry = Object.entries(frame.emotions).find(([, v]) => (v ?? 0) > 0.1);
  const emotion = (emotionEntry?.[0] ?? 'neutral') as keyof typeof avatar.morphMap.emotions;

  if (avatar.faceMesh?.morphTargetInfluences) {
    applyMorphWeights(
      avatar.morphIndex,
      avatar.faceMesh.morphTargetInfluences,
      {
        jawOpen: frame.jawOpen,
        emotion,
        emotionIntensity: frame.emotions[emotion] ?? 0.35,
        viseme: frame.viseme,
      },
      avatar.morphMap,
    );
  } else if (avatar.head) {
    avatar.head.scale.y = 1 - frame.jawOpen * 0.06;
    avatar.head.scale.z = 1 + frame.jawOpen * 0.04;
  }
}
