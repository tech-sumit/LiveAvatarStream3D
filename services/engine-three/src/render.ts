import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  Color,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { PNG } from 'pngjs';
import type { PerformanceManifest } from '@las/protocol';
import type { Config } from './config.js';
import { resolveResolution } from './config.js';
import { bakeFaceAnimation } from './face/a2f.js';
import { loadAvatar } from './avatar/loadAvatar.js';
import { buildStage } from './stage.js';
import { applyTimeline, applyTimelineFaceOnly } from './timeline.js';
import { setupEditorScene } from './sceneGraph.js';
import { R2Client } from './r2.js';
import { patchHeadlessGlContext } from './patchGlContext.js';

interface HeadlessGL {
  RGBA: number;
  UNSIGNED_BYTE: number;
  readPixels(
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    pixels: Uint8Array,
  ): void;
  getExtension(name: string): { destroy?: () => void } | null;
}

/** Minimal canvas stub so Three.js WebGLRenderer skips document.createElement. */
function headlessCanvas(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
}

async function createHeadlessContext(width: number, height: number): Promise<HeadlessGL> {
  try {
    const mod = await import('gl');
    const createGL = mod.default;
    return createGL(width, height, { preserveDrawingBuffer: true, antialias: true }) as HeadlessGL;
  } catch {
    throw new Error(
      'headless WebGL (npm package "gl") is not installed — run on the Linux GPU pod.',
    );
  }
}

export interface RenderResult {
  mp4Path: string;
  frameCount: number;
}

export async function renderFromManifest(opts: {
  cfg: Config;
  manifest: PerformanceManifest;
  audioPath: string;
  workDir: string;
  outputName: string;
  onProgress?: (progress: number, message: string) => void;
}): Promise<RenderResult> {
  const { cfg, manifest, audioPath, workDir, outputName, onProgress } = opts;
  if (cfg.renderBackend === 'playwright') {
    throw new Error(
      'RENDER_BACKEND=playwright is not implemented; use RENDER_BACKEND=gl on the Linux GPU pod',
    );
  }
  const { width, height } = resolveResolution(
    cfg,
    manifest.resolution.width,
    manifest.resolution.height,
  );
  const fps = manifest.fps;
  const frameCount = Math.max(1, Math.ceil(manifest.durationS * fps));
  const deltaS = 1 / fps;

  await rm(workDir, { recursive: true, force: true });
  const framesDir = join(workDir, 'frames');
  await mkdir(framesDir, { recursive: true });

  onProgress?.(0.55, 'Baking face animation');
  const faceFrames = await bakeFaceAnimation(cfg, manifest, audioPath);

  onProgress?.(0.6, 'Building Three.js scene');
  const scene = new Scene();
  const avatar = await loadAvatar(cfg, manifest);
  scene.add(avatar.root);

  const aspect = width / height;
  const camera = new PerspectiveCamera(50, aspect, 0.1, 100);
  const useEditorScene = !!manifest.scene;

  if (useEditorScene) {
    const r2 = new R2Client(cfg);
    await setupEditorScene({
      cfg,
      doc: manifest.scene!,
      threeScene: scene,
      avatar,
      camera,
      aspect,
      workDir,
      r2,
    });
  } else {
    await buildStage(cfg, scene, manifest.stage.lighting);
    camera.fov = 50;
    camera.updateProjectionMatrix();
  }

  const camNode = manifest.scene?.nodes.find(
    (n) => n.type === 'camera' && n.id === manifest.scene!.activeCameraId,
  );
  // #region agent log
  const renderDiag = {
    useEditorScene,
    stageAvatarId: manifest.stage.avatarId,
    avatarKind: avatar.decalLipsync
      ? 'lee_perry_smith'
      : avatar.proceduralMontages
        ? 'placeholder_procedural'
        : 'gltf',
    sceneNodeCount: manifest.scene?.nodes.length ?? 0,
    activeCameraId: manifest.scene?.activeCameraId,
    cameraTransform: camNode?.type === 'camera' ? camNode.transform : null,
    renderCameraPos: [camera.position.x, camera.position.y, camera.position.z],
    renderCameraRotDeg: [
      (camera.rotation.x * 180) / Math.PI,
      (camera.rotation.y * 180) / Math.PI,
      (camera.rotation.z * 180) / Math.PI,
    ],
    sceneChildren: scene.children.map((c) => c.type),
  };
  console.error('[las-render-setup]', JSON.stringify(renderDiag));
  fetch('http://127.0.0.1:7445/ingest/d520ae88-7e66-4f86-8787-69592b53c18f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f4aab0'},body:JSON.stringify({sessionId:'f4aab0',location:'render.ts:setup',message:'render scene setup',data:renderDiag,timestamp:Date.now(),hypothesisId:'render-setup'})}).catch(()=>{});
  // #endregion

  const context = await createHeadlessContext(width, height);
  patchHeadlessGlContext(context);
  const renderer = new WebGLRenderer({
    canvas: headlessCanvas(width, height),
    context: context as unknown as WebGLRenderingContext,
    antialias: true,
  });
  renderer.setSize(width, height, false);
  renderer.setClearColor(
    useEditorScene ? new Color(manifest.scene!.stage.background) : new Color(0x1a2030),
    1,
  );
  renderer.outputColorSpace = SRGBColorSpace;

  onProgress?.(0.65, `Rendering ${frameCount} frames @ ${width}x${height}`);
  const gl = renderer.getContext() as HeadlessGL & { finish?: () => void };
  for (let f = 0; f < frameCount; f++) {
    if (useEditorScene) {
      applyTimelineFaceOnly(manifest, avatar, faceFrames, f, deltaS);
    } else {
      applyTimeline(manifest, camera, avatar, faceFrames, f, deltaS);
    }
    renderer.render(scene, camera);
    gl.finish?.();

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcY = height - 1 - y;
        const srcI = (srcY * width + x) * 4;
        const dstI = (y * width + x) * 4;
        png.data[dstI] = pixels[srcI];
        png.data[dstI + 1] = pixels[srcI + 1];
        png.data[dstI + 2] = pixels[srcI + 2];
        png.data[dstI + 3] = 255;
      }
    }

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(framesDir, `${String(f).padStart(6, '0')}.png`), PNG.sync.write(png));

    if (f % Math.max(1, Math.floor(frameCount / 10)) === 0) {
      onProgress?.(0.65 + (f / frameCount) * 0.25, `Frame ${f + 1}/${frameCount}`);
    }
  }

  context.getExtension('STACKGL_destroy_context')?.destroy?.();

  onProgress?.(0.92, 'Muxing audio with ffmpeg');
  const mp4Path = join(workDir, `${outputName}.mp4`);
  await muxVideo(framesDir, audioPath, mp4Path, fps);
  await rm(framesDir, { recursive: true, force: true });

  return { mp4Path, frameCount };
}

function muxVideo(framesDir: string, audioPath: string, outPath: string, fps: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(framesDir, '%06d.png'),
      '-i',
      audioPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-preset',
      'medium',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += String(d);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
    });
  });
}
