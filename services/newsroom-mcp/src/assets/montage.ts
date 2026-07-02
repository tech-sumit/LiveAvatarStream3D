/**
 * Newsroom MCP — back-screen montage builder (task NM-8, Phase 2 / Tier 2).
 *
 * Stitch a list of broadcast-card PNGs (1920x1080, from `assets/cards.ts`) into
 * a single silent montage MP4 with slow crossfades — the loop that plays on the
 * studio back-wall while the anchor reads. Ported from the proven session ffmpeg
 * command: each card is shown for a few seconds and `xfade`d into the next.
 *
 * Runs entirely in the MCP process by spawning `ffmpeg`. Throws a clear error if
 * `ffmpeg` is missing or the encode fails.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workDir } from './serve.js';

export interface MontageOptions {
  /** Seconds each card holds on screen (incl. the crossfade). Default 5.5. */
  perCardSeconds?: number;
  /** Crossfade duration between cards (seconds). Default 1.0. */
  crossfadeSeconds?: number;
  /** Output frame rate. Default 30. */
  fps?: number;
  /** Output basename (without extension) inside the work dir. */
  basename?: string;
}

const WIDTH = 1920;
const HEIGHT = 1080;

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
        new Error(
          `ffmpeg could not be started (is it installed and on PATH?): ${String(err)}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}. stderr tail:\n${stderr.trim()}`));
    });
  });
}

/**
 * Build a silent 1920x1080 crossfade montage MP4 from the given card PNG paths.
 *
 * @param cardPaths Ordered local paths to 1920x1080 PNG cards. Must be ≥1.
 * @param opts      Timing/output overrides.
 * @returns The local path to the written MP4 (in the transport work dir).
 */
export async function buildMontage(
  cardPaths: string[],
  opts: MontageOptions = {},
): Promise<string> {
  if (!cardPaths.length) {
    throw new Error('buildMontage: at least one card path is required.');
  }
  for (const p of cardPaths) {
    if (!existsSync(p)) throw new Error(`buildMontage: card not found: ${p}`);
  }

  const per = Math.max(1.5, opts.perCardSeconds ?? 5.5);
  const xf = Math.max(0.2, Math.min(opts.crossfadeSeconds ?? 1.0, per - 0.5));
  const fps = opts.fps ?? 30;
  const out = join(workDir(), `${opts.basename ?? `montage-${randomUUID().slice(0, 8)}`}.mp4`);

  // Each still loops for `per` seconds. We normalize size/SAR/fps so xfade lines
  // up, then chain xfade transitions. With N cards the total duration is
  // per*N - xf*(N-1) (each transition overlaps the two neighbours).
  const args: string[] = [];
  for (const p of cardPaths) {
    args.push('-loop', '1', '-t', String(per), '-i', p);
  }

  const n = cardPaths.length;
  const filters: string[] = [];
  for (let i = 0; i < n; i++) {
    filters.push(
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x0a1020,` +
        `setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  }

  let lastLabel = 'v0';
  if (n === 1) {
    // Single card: no transitions, just the normalized stream.
    filters.push(`[v0]null[vout]`);
    lastLabel = 'vout';
  } else {
    for (let i = 1; i < n; i++) {
      const outLabel = i === n - 1 ? 'vout' : `x${i}`;
      // Offset where this transition begins on the running timeline.
      const offset = (per - xf) * i;
      filters.push(
        `[${lastLabel}][v${i}]xfade=transition=fade:duration=${xf.toFixed(3)}:` +
          `offset=${offset.toFixed(3)}[${outLabel}]`,
      );
      lastLabel = outLabel;
    }
  }

  args.push(
    '-y',
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${lastLabel}]`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-movflags',
    '+faststart',
    out,
  );

  await runFfmpeg(args);
  if (!existsSync(out)) {
    throw new Error('buildMontage: ffmpeg reported success but no output file was written.');
  }
  return out;
}
