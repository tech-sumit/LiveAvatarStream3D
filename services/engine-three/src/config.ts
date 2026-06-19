import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type LipsyncMode = 'envelope' | 'viseme' | 'a2f';
export type MontageMode = 'procedural' | 'gltf';
export type RenderBackend = 'gl' | 'playwright';
export type RenderProfile = 'dev' | 'prod';

/** Runtime configuration for the Three.js render node. */
export interface Config {
  port: number;
  internalToken: string;
  controlApiUrl: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  outputsBucket: string;
  assetsDir: string;
  a2fNimUrl: string | undefined;
  lipsyncMode: LipsyncMode;
  montageMode: MontageMode;
  renderBackend: RenderBackend;
  renderProfile: RenderProfile;
  maxWidth: number;
  maxHeight: number;
  renderTimeoutS: number;
  rhubarbPath: string;
  workDir: string;
}

export function loadConfig(): Config {
  const workDir = process.env.LAS_WORK_DIR ?? mkdtempSync(join(tmpdir(), 'las-engine-'));
  return {
    port: Number(process.env.PORT ?? 8090),
    internalToken: process.env.INTERNAL_SERVICE_TOKEN ?? 'change-me',
    controlApiUrl: (process.env.CONTROL_API_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
    r2Endpoint: process.env.R2_ENDPOINT ?? '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    outputsBucket: process.env.R2_OUTPUTS_BUCKET ?? 'las-outputs',
    assetsDir:
      process.env.LAS_ASSETS_DIR ?? fileURLToPath(new URL('../assets', import.meta.url)),
    a2fNimUrl: process.env.A2F_NIM_URL?.replace(/\/$/, ''),
    lipsyncMode: (process.env.LIPSYNC_MODE ?? 'envelope') as LipsyncMode,
    montageMode: (process.env.MONTAGE_MODE ?? 'procedural') as MontageMode,
    renderBackend: (process.env.RENDER_BACKEND ?? 'gl') as RenderBackend,
    renderProfile: (process.env.RENDER_PROFILE ?? 'prod') as RenderProfile,
    maxWidth: Number(process.env.MAX_RENDER_WIDTH ?? 3840),
    maxHeight: Number(process.env.MAX_RENDER_HEIGHT ?? 2160),
    renderTimeoutS: Number(process.env.RENDER_TIMEOUT_S ?? 600),
    rhubarbPath: process.env.RHUBARB_PATH ?? 'rhubarb',
    workDir,
  };
}

export function resolveResolution(
  cfg: Config,
  manifestW: number,
  manifestH: number,
): { width: number; height: number } {
  if (cfg.renderProfile === 'dev') {
    return { width: 1920, height: 1080 };
  }
  return {
    width: Math.min(manifestW, cfg.maxWidth),
    height: Math.min(manifestH, cfg.maxHeight),
  };
}
