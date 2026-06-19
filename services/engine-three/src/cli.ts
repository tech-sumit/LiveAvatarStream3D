#!/usr/bin/env tsx
/** Local manifest render (no R2) for development spikes. */
import { readFile } from 'node:fs/promises';
import { PerformanceManifest } from '@las/protocol';
import { loadConfig } from './config.js';
import { renderFromManifest } from './render.js';

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  const audioPath = process.argv[3];
  const outDir = process.argv[4] ?? './out';
  if (!manifestPath || !audioPath) {
    console.error('Usage: npm run render:local -- <manifest.json> <audio.wav> [outDir]');
    process.exit(1);
  }

  const cfg = loadConfig();
  const manifest = PerformanceManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')));

  const { mp4Path, frameCount } = await renderFromManifest({
    cfg,
    manifest,
    audioPath,
    workDir: `${outDir}/work`,
    outputName: manifest.jobId,
    onProgress: (p, m) => console.log(`${(p * 100).toFixed(0)}% ${m}`),
  });

  console.log(`Done: ${mp4Path} (${frameCount} frames)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
