import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Config } from '../config.js';

export interface VisemeCue {
  timeS: number;
  shape: string;
}

/** Run Rhubarb Lip Sync if available; returns viseme cues keyed by time. */
export async function extractVisemes(cfg: Config, audioPath: string): Promise<VisemeCue[]> {
  const rhubarb = cfg.rhubarbPath;
  const outJson = join(cfg.workDir, 'rhubarb.json');
  try {
    await runRhubarb(rhubarb, audioPath, outJson);
    const raw = JSON.parse(await readFile(outJson, 'utf8')) as {
      mouthCues?: { start: number; end: number; value: string }[];
    };
    return (raw.mouthCues ?? []).map((c) => ({
      timeS: c.start,
      shape: c.value,
    }));
  } catch {
    return [];
  }
}

function runRhubarb(bin: string, audioPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-f', 'json', '-o', outPath, audioPath], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rhubarb exited ${code}`));
    });
  });
}

export function visemeAtTime(cues: VisemeCue[], t: number): string | undefined {
  for (let i = cues.length - 1; i >= 0; i--) {
    if (t >= cues[i].timeS) return cues[i].shape;
  }
  return cues[0]?.shape;
}
