/**
 * Newsroom MCP — post-production (task NM-8, Phase 2 / Tier 2).
 *
 * Take a rendered newscast MP4 (e.g. an `export_mp4` capture of the studio) and
 * finish it for broadcast by spawning `ffmpeg`:
 *
 *   - optional **intro title card**: a PNG held for a few seconds with a slow
 *     zoom (Ken-Burns), concatenated in front of the body;
 *   - a **music bed**: full level over the intro, ducked under the narration of
 *     the body, faded out at the tail;
 *   - optional **lower-third overlays**: PNGs (with alpha) shown over the body
 *     between given start/end times.
 *
 * Mirrors the proven session post pipeline. Runs entirely in the MCP process;
 * throws a clear error if `ffmpeg` is missing or any stage fails.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workDir } from '../transport.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

export interface LowerThird {
  /** Local path to a 1920x1080 PNG overlay (alpha respected). */
  path: string;
  /** Show from this time (seconds, on the body timeline). Default 0. */
  start?: number;
  /** Hide at this time (seconds). Default start + 5. */
  end?: number;
}

export interface PostOptions {
  /** Local path to an intro title-card PNG. Held + zoomed before the body. */
  introCard?: string;
  /** Seconds to hold the intro card. Default 4. */
  introSeconds?: number;
  /** Local path to a music-bed WAV/MP3. Full over intro, ducked under body. */
  musicWav?: string;
  /** Music level under narration (0..1). Default 0.18. */
  musicDuckLevel?: number;
  /** Music level over the intro (0..1). Default 0.85. */
  musicIntroLevel?: number;
  /** Optional lower-third overlays on the body. */
  lowerThirds?: LowerThird[];
  /** Output basename (without extension) inside the work dir. */
  basename?: string;
}

/** Run ffmpeg with the given args; resolve on exit 0, reject with stderr otherwise. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new Error(`Failed to spawn ffmpeg (is it installed and on PATH?): ${String(err)}`));
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      reject(
        new Error(`ffmpeg could not be started (is it installed and on PATH?): ${String(err)}`),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}. stderr tail:\n${stderr.trim()}`));
    });
  });
}

/** ffprobe the duration (seconds) of a media file. */
function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          path,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      reject(new Error(`Failed to spawn ffprobe (ffmpeg not installed?): ${String(err)}`));
      return;
    }
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', (err) => reject(new Error(`ffprobe failed: ${String(err)}`)));
    child.on('close', (code) => {
      const d = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(d) && d > 0) resolve(d);
      else reject(new Error(`ffprobe could not read a duration from ${path}.`));
    });
  });
}

/** ffprobe whether a media file has at least one audio stream. */
function probeHasAudio(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.trim().length > 0));
  });
}

/**
 * Render the intro title card to a short MP4 (held PNG + slow zoom), matching the
 * body's size/fps so it can be concatenated cleanly.
 */
async function buildIntroClip(card: string, seconds: number, basename: string): Promise<string> {
  const out = join(workDir(), `${basename}-intro.mp4`);
  const frames = Math.max(2, Math.round(seconds * FPS));
  // Ken-Burns: scale up to allow zoompan, slow zoom from 1.0 to ~1.08.
  const filter =
    `scale=${WIDTH * 2}:${HEIGHT * 2},` +
    `zoompan=z='min(zoom+0.0008,1.08)':d=${frames}:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
    `setsar=1,format=yuv420p`;
  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-i',
    card,
    '-vf',
    filter,
    // `-t` here is an OUTPUT limit: hold the looped card for exactly `seconds`.
    // (As an input option before -i it would, with zoompan d=frames, blow the
    // clip up to seconds*frames long and bury the body under the intro.)
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    out,
  ]);
  return out;
}

/**
 * Post-produce a newscast MP4. Returns the local path to the finished MP4 in the
 * work dir.
 *
 * Pipeline: (1) optionally build an intro clip and concat it in front of the
 * body; (2) overlay lower-thirds on the body region; (3) if a music bed is
 * given, mix it (full over the intro, ducked under the body) and fade it out.
 *
 * @param inputMp4 Local path to the source newscast MP4.
 * @param opts     Intro / music / lower-third options.
 */
export async function postProduce(inputMp4: string, opts: PostOptions = {}): Promise<string> {
  if (!existsSync(inputMp4)) throw new Error(`postProduce: input not found: ${inputMp4}`);
  const base = opts.basename ?? `post-${randomUUID().slice(0, 8)}`;
  const out = join(workDir(), `${base}.mp4`);

  const introSeconds = opts.introCard ? Math.max(1, opts.introSeconds ?? 4) : 0;
  const lowerThirds = opts.lowerThirds ?? [];
  for (const lt of lowerThirds) {
    if (!existsSync(lt.path)) throw new Error(`postProduce: lower-third not found: ${lt.path}`);
  }
  if (opts.introCard && !existsSync(opts.introCard)) {
    throw new Error(`postProduce: intro card not found: ${opts.introCard}`);
  }
  if (opts.musicWav && !existsSync(opts.musicWav)) {
    throw new Error(`postProduce: music bed not found: ${opts.musicWav}`);
  }

  const bodyDuration = await probeDuration(inputMp4);
  const totalDuration = bodyDuration + introSeconds;
  const bodyHasAudio = await probeHasAudio(inputMp4);

  // ---- Step 1: a normalized "body" stream (with any lower-thirds baked in). ----
  // We feed: [0]=intro clip (optional), [1]=body mp4, [2..]=lower-third PNGs,
  // [last]=music (optional). Build the input list + filter graph dynamically.
  const inputs: string[] = [];
  const introClip = opts.introCard
    ? await buildIntroClip(opts.introCard, introSeconds, base)
    : null;

  if (introClip) inputs.push('-i', introClip);
  const bodyIdx = introClip ? 1 : 0;
  inputs.push('-i', inputMp4);

  const ltStartIdx = bodyIdx + 1;
  for (const lt of lowerThirds) inputs.push('-i', lt.path);

  const musicIdx = ltStartIdx + lowerThirds.length;
  if (opts.musicWav) inputs.push('-stream_loop', '-1', '-i', opts.musicWav);

  const filters: string[] = [];

  // Normalize the body video, then apply lower-third overlays in sequence.
  filters.push(
    `[${bodyIdx}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[body0]`,
  );
  let bodyLabel = 'body0';
  lowerThirds.forEach((lt, i) => {
    const start = Math.max(0, lt.start ?? 0);
    const end = lt.end ?? start + 5;
    const inLabel = i; // ltStartIdx + i
    filters.push(
      `[${ltStartIdx + inLabel}:v]scale=${WIDTH}:${HEIGHT},setsar=1,format=rgba[lt${i}]`,
    );
    const next = `bodyL${i}`;
    filters.push(
      `[${bodyLabel}][lt${i}]overlay=0:0:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${next}]`,
    );
    bodyLabel = next;
  });

  // Concat the intro clip (if any) in front of the (overlaid) body.
  let videoLabel: string;
  if (introClip) {
    filters.push(
      `[0:v]scale=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},format=yuv420p[intro]`,
    );
    filters.push(`[intro][${bodyLabel}]concat=n=2:v=1:a=0[vout]`);
    videoLabel = 'vout';
  } else {
    filters.push(`[${bodyLabel}]copy[vout]`);
    videoLabel = 'vout';
  }

  // ---- Audio ----
  // Body audio: shift it past the intro so narration lines up with the body video.
  // (If the body has no audio track ffmpeg's amix tolerates the missing stream
  // only when we explicitly provide a silent base, so we synthesize silence.)
  const audioParts: string[] = [];
  let audioLabel = '';

  // Silent base spanning the whole output so we always have an audio track.
  filters.push(
    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalDuration.toFixed(3)}[abase]`,
  );
  audioParts.push('[abase]');

  // Body narration (only if the source actually has an audio stream): delay by
  // the intro length so narration lines up with the body video.
  if (bodyHasAudio) {
    const delayMs = Math.round(introSeconds * 1000);
    filters.push(`[${bodyIdx}:a]aresample=48000,adelay=${delayMs}|${delayMs}[bodya]`);
    audioParts.push('[bodya]');
  }

  if (opts.musicWav) {
    const introLvl = opts.musicIntroLevel ?? 0.85;
    const duckLvl = opts.musicDuckLevel ?? 0.18;
    // Music: full over the intro, ducked under the body, fade out at the tail.
    // Volume is automated with a time expression: high until intro end, then duck.
    const fadeStart = Math.max(0, totalDuration - 1.5);
    const volExpr = introSeconds > 0
      ? `if(lt(t,${introSeconds.toFixed(2)}),${introLvl},${duckLvl})`
      : `${duckLvl}`;
    filters.push(
      `[${musicIdx}:a]aresample=48000,atrim=0:${totalDuration.toFixed(3)},` +
        `volume='${volExpr}':eval=frame,` +
        `afade=t=out:st=${fadeStart.toFixed(2)}:d=1.5[music]`,
    );
    audioParts.push('[music]');
  }

  filters.push(
    `${audioParts.join('')}amix=inputs=${audioParts.length}:duration=first:dropout_transition=0[aout]`,
  );
  audioLabel = 'aout';

  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoLabel}]`,
    '-map',
    `[${audioLabel}]`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-r',
    String(FPS),
    '-t',
    totalDuration.toFixed(3),
    '-movflags',
    '+faststart',
    out,
  ];

  await runFfmpeg(args);
  if (!existsSync(out)) {
    throw new Error('postProduce: ffmpeg reported success but no output file was written.');
  }
  return out;
}
