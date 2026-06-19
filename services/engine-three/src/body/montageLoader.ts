import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnimationClip, AnimationMixer, LoopRepeat } from 'three';
import type { MontageId } from '@las/protocol';
import type { Config } from '../config.js';
import { createGltfLoader } from '../gltfLoader.js';

const MONTAGE_IDS: MontageId[] = ['M_Explain', 'M_LeanIn', 'M_Nod'];

export class MontageController {
  private readonly clips = new Map<MontageId, AnimationClip>();
  private activeAction: ReturnType<AnimationMixer['clipAction']> | null = null;
  private activeId: MontageId | null = null;

  constructor(
    readonly mixer: AnimationMixer,
    private readonly mode: 'gltf' | 'procedural',
  ) {}

  static async load(cfg: Config, mixer: AnimationMixer): Promise<MontageController> {
    const mode = cfg.montageMode;
    const ctrl = new MontageController(mixer, mode);
    if (mode === 'gltf') {
      const loader = await createGltfLoader();
      for (const id of MONTAGE_IDS) {
        const path = join(cfg.assetsDir, 'anims', `${id}.glb`);
        if (!existsSync(path)) continue;
        const buf = await readFile(path);
        const gltf = await loader.parseAsync(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          path,
        );
        const clip = gltf.animations[0];
        if (clip) ctrl.clips.set(id, clip);
      }
    }
    return ctrl;
  }

  update(delta: number): void {
    this.mixer.update(delta);
  }

  applyMontage(montageId: MontageId | null): void {
    if (this.mode === 'procedural' || !montageId || !this.clips.has(montageId)) {
      if (this.activeAction) {
        this.activeAction.fadeOut(0.2);
        this.activeAction = null;
        this.activeId = null;
      }
      return;
    }
    if (this.activeId === montageId && this.activeAction?.isRunning()) return;
    const clip = this.clips.get(montageId)!;
    const next = this.mixer.clipAction(clip);
    next.reset().setLoop(LoopRepeat, Infinity).fadeIn(0.2).play();
    if (this.activeAction && this.activeAction !== next) {
      this.activeAction.crossFadeTo(next, 0.2, false);
    }
    this.activeAction = next;
    this.activeId = montageId;
  }
}

export interface AvatarRegistryEntry {
  glb: string;
  forwardAxis: string;
  eyeHeightM: number;
  morphMap: string;
}

export async function loadRegistry(assetsDir: string): Promise<Record<string, AvatarRegistryEntry>> {
  const raw = await readFile(join(assetsDir, 'avatars', 'registry.json'), 'utf8');
  return JSON.parse(raw) as Record<string, AvatarRegistryEntry>;
}

export function resolveAvatarPath(cfg: Config, avatarId: string): string {
  const id = avatarId.replace(/^BP_/i, '').toLowerCase();
  return join(cfg.assetsDir, 'avatars', `${id}.glb`);
}
