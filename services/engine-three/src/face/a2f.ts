import type { A2FEmotion, ManifestBeat, PerformanceManifest } from '@las/protocol';
import { readFile } from 'node:fs/promises';
import wavefileModule from 'wavefile';
import type { Config } from '../config.js';
import { extractVisemes, visemeAtTime } from './viseme.js';

const WaveFile = (wavefileModule as { WaveFile: new (buffer: Buffer) => WaveFileInstance }).WaveFile;

interface WaveFileInstance {
  toBitDepth(bitDepth: string): void;
  getSamples(interleaved: boolean, OutputObject?: Int16ArrayConstructor): Int16Array | Float64Array;
  sampleRate: number;
}

/** Per-frame facial drive: jaw open 0..1 plus emotion blend weights. */
export interface FaceFrame {
  jawOpen: number;
  emotions: Partial<Record<A2FEmotion, number>>;
  viseme?: string;
}

function beatsAtTime(beats: ManifestBeat[], t: number): ManifestBeat {
  for (let i = beats.length - 1; i >= 0; i--) {
    if (t >= beats[i].startS) return beats[i];
  }
  return beats[0];
}

function emotionWeights(beat: ManifestBeat): Partial<Record<A2FEmotion, number>> {
  const w: Partial<Record<A2FEmotion, number>> = { neutral: 0.05 };
  w[beat.face.a2fEmotion] = beat.face.intensity;
  return w;
}

function jawFromEnvelope(
  samples: Int16Array,
  sampleRate: number,
  frameIndex: number,
  fps: number,
): number {
  const centerSample = Math.floor((frameIndex / fps) * sampleRate);
  const window = Math.floor(sampleRate * 0.04);
  const start = Math.max(0, centerSample - window);
  const end = Math.min(samples.length, centerSample + window);
  let peak = 0;
  for (let i = start; i < end; i++) {
    peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  }
  return Math.min(1, peak / 12000);
}

async function fetchA2fNim(
  cfg: Config,
  manifest: PerformanceManifest,
  audioPath: string,
  frameCount: number,
  fps: number,
): Promise<FaceFrame[] | null> {
  if (!cfg.a2fNimUrl) return null;
  const audioB64 = (await readFile(audioPath)).toString('base64');
  const res = await fetch(`${cfg.a2fNimUrl}/v1/audio2face/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jobId: manifest.jobId,
      audioBase64: audioB64,
      fps,
      frameCount,
      emotionTimeline: manifest.beats.map((b) => ({
        startS: b.startS,
        endS: b.endS,
        emotion: b.face.a2fEmotion,
        intensity: b.face.intensity,
      })),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    frames?: { jawOpen?: number; emotions?: Partial<Record<A2FEmotion, number>> }[];
  };
  if (!data.frames?.length) return null;
  return data.frames.map((fr) => ({
    jawOpen: fr.jawOpen ?? 0,
    emotions: fr.emotions ?? { neutral: 1 },
  }));
}

/**
 * Bake per-frame face drive from audio + manifest beats.
 * Mode controlled by LIPSYNC_MODE: envelope | viseme | a2f
 */
export async function bakeFaceAnimation(
  cfg: Config,
  manifest: PerformanceManifest,
  audioPath: string,
): Promise<FaceFrame[]> {
  const fps = manifest.fps;
  const frameCount = Math.max(1, Math.ceil(manifest.durationS * fps));
  const beats = manifest.beats;

  if (cfg.lipsyncMode === 'a2f') {
    try {
      const nimFrames = await fetchA2fNim(cfg, manifest, audioPath, frameCount, fps);
      if (nimFrames) return nimFrames;
    } catch (e) {
      console.warn('[a2f] NIM bake failed, using fallback:', e);
    }
  }

  const buf = await readFile(audioPath);
  const wav = new WaveFile(buf);
  wav.toBitDepth('16');
  const samples = wav.getSamples(false, Int16Array) as Int16Array;
  const sampleRate = wav.sampleRate;

  let visemeCues: Awaited<ReturnType<typeof extractVisemes>> = [];
  if (cfg.lipsyncMode === 'viseme') {
    visemeCues = await extractVisemes(cfg, audioPath);
  }

  const frames: FaceFrame[] = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    const beat = beatsAtTime(beats, t);
    const viseme = visemeCues.length ? visemeAtTime(visemeCues, t) : undefined;
    frames.push({
      jawOpen:
        cfg.lipsyncMode === 'viseme' && viseme
          ? 0
          : jawFromEnvelope(samples, sampleRate, f, fps),
      emotions: emotionWeights(beat),
      viseme,
    });
  }
  return frames;
}
