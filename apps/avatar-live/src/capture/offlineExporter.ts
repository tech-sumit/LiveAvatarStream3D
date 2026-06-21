import type { Stage } from '../scene/stage.js';
import type { MouthCue } from '../avatar/avatarController.js';
import { Mp4Encoder, pickVideoCodec, type VideoCodecChoice } from './mp4Encoder.js';
import { precomputeMouthTrack } from './offlineLipsync.js';
import { renderMixdown, type AudioClip } from './offlineAudio.js';

export interface OfflineExportOpts {
  stage: Stage;
  narration: AudioBuffer;
  audioCues: AudioClip[]; // [] for SP-1 MVP (music beds are a follow-up)
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  codec: VideoCodecChoice;
  /** Per-frame avatar drive (camera/emotion/clip/mouth/step). Caller supplies it. */
  driveFrame: (t: number, dt: number, mouth: MouthCue) => void;
  onProgress?: (done: number, total: number) => void;
}

const SILENT: MouthCue = { jawOpen: 0, mouthWide: 0, mouthRound: 0, mouthClose: 0 };

/**
 * Frame-exact offline MP4 export. Drives the clock by frame index (t = i/fps), so
 * there are zero dropped frames and the muxed audio stays in exact sync. Runs on the
 * main thread; yields every 30 frames so the progress UI can paint. The caller MUST
 * have suspended the realtime render loop (see Performer.exporting) before calling.
 */
export async function exportMp4Offline(opts: OfflineExportOpts): Promise<Blob> {
  const codec = await pickVideoCodec(opts.codec, opts.width, opts.height);
  if (!codec) throw new Error('No MP4 video codec available in this browser');

  const total = Math.max(1, Math.ceil(opts.durationSec * opts.fps));
  const mouth = precomputeMouthTrack(opts.narration, opts.fps);
  const audio = await renderMixdown({
    narration: opts.narration,
    cues: opts.audioCues,
    durationSec: opts.durationSec,
  });

  const canvas = opts.stage.renderOutputFrame(); // stable canvas ref for the encoder
  const enc = new Mp4Encoder({ canvas, fps: opts.fps, codec });
  enc.addAudioTrack();
  await enc.start();

  const dt = 1 / opts.fps;
  for (let i = 0; i < total; i++) {
    const t = i / opts.fps;
    opts.driveFrame(t, dt, mouth[i] ?? SILENT);
    opts.stage.renderOutputFrame();
    await enc.addFrame(i);
    if (opts.onProgress && (i % 5 === 0 || i === total - 1)) opts.onProgress(i + 1, total);
    if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
  }

  await enc.addAudio(audio);
  return enc.finish();
}
