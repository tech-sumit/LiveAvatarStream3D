import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceManifest } from '@las/protocol';
import type { Config } from './config.js';
import { R2Client } from './r2.js';
import { renderFromManifest } from './render.js';
import { ProgressReporter } from './webhook.js';

export interface RenderJobBody {
  jobId: string;
  manifestKey: string;
  outputKey: string;
}

export async function runRenderJob(cfg: Config, body: RenderJobBody): Promise<void> {
  const reporter = new ProgressReporter(body.jobId, cfg);
  const r2 = new R2Client(cfg);
  const workRoot = await mkdtemp(join(tmpdir(), `las-render-${body.jobId}-`));

  const timeoutMs = cfg.renderTimeoutS * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  try {
    await reporter.report({ status: 'rendering', progress: 0.52, message: 'Downloading manifest' });

    const manifestPath = join(workRoot, 'manifest.json');
    await r2.download(cfg.outputsBucket, body.manifestKey, manifestPath);
    const manifest = PerformanceManifest.parse(JSON.parse(await readText(manifestPath)));

    const audioPath = join(workRoot, 'audio.wav');
    await r2.download(cfg.outputsBucket, manifest.audio.r2Key, audioPath);

    if (timedOut) throw new Error(`render timed out after ${cfg.renderTimeoutS}s`);

    const { mp4Path } = await renderFromManifest({
      cfg,
      manifest,
      audioPath,
      workDir: join(workRoot, 'render'),
      outputName: body.jobId,
      onProgress: (progress, message) => {
        if (timedOut) return;
        void reporter.report({ status: 'rendering', progress, message });
      },
    });

    if (timedOut) throw new Error(`render timed out after ${cfg.renderTimeoutS}s`);

    await reporter.report({ status: 'rendering', progress: 0.97, message: 'Uploading mp4' });
    await r2.uploadFile(mp4Path, cfg.outputsBucket, body.outputKey, 'video/mp4');
    await reporter.report({
      status: 'succeeded',
      progress: 1,
      message: 'Three.js render complete',
      outputKey: body.outputKey,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`render job ${body.jobId} failed:`, e);
    await reporter.report({ status: 'failed', error: msg });
  } finally {
    clearTimeout(timer);
  }
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}
