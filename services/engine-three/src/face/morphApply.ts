import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { A2FEmotion } from '@las/protocol';

export interface MorphMapFile {
  jawOpen: { jawOpen: number };
  emotions: Record<A2FEmotion, Record<string, number>>;
  visemes: Record<string, Record<string, number>>;
}

export async function loadMorphMap(assetsDir: string, mapId: string): Promise<MorphMapFile> {
  const raw = await readFile(
    join(assetsDir, 'avatars', 'morph_maps', `${mapId}.json`),
    'utf8',
  );
  return JSON.parse(raw) as MorphMapFile;
}

/** Apply jaw + emotion weights to a morph influence array. */
export function applyMorphWeights(
  morphIndex: Record<string, number>,
  influences: number[],
  opts: { jawOpen: number; emotion: A2FEmotion; emotionIntensity: number; viseme?: string },
  map: MorphMapFile,
): void {
  influences.fill(0);

  const jawScale = opts.jawOpen * map.jawOpen.jawOpen;
  const jawIdx = morphIndex.jawOpen;
  if (jawIdx !== undefined) influences[jawIdx] = jawScale;

  const emotionBlend = map.emotions[opts.emotion] ?? {};
  for (const [name, w] of Object.entries(emotionBlend)) {
    const idx = morphIndex[name];
    if (idx !== undefined) influences[idx] = w * opts.emotionIntensity;
  }

  if (opts.viseme && map.visemes[opts.viseme]) {
    for (const [name, w] of Object.entries(map.visemes[opts.viseme])) {
      const idx = morphIndex[name];
      if (idx !== undefined) influences[idx] = Math.max(influences[idx] ?? 0, w);
    }
  }
}

/** Build morph index from Three.js morphTargetDictionary. */
export function buildMorphIndex(dict: Record<string, number> | undefined): Record<string, number> {
  return dict ? { ...dict } : {};
}

/** Ensure placeholder mesh has minimal morph targets for POC without ada.glb. */
export function ensurePlaceholderMorphs(
  morphIndex: Record<string, number>,
  influences: number[],
  names: string[],
): void {
  for (const n of names) {
    if (morphIndex[n] === undefined) {
      morphIndex[n] = influences.length;
      influences.push(0);
    }
  }
}
