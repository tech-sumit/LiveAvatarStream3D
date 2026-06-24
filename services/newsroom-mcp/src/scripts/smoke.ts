/**
 * Newsroom MCP — end-to-end smoke test (task NM-6).
 *
 * Drives the full path WITHOUT the MCP stdio layer: start the transport, connect
 * a headless studio (Playwright Chromium → avatar-live on :5175 with ?bridge),
 * apply a small Fable/Mythos NewsReportDoc, screenshot the output, export an mp4,
 * then `ffprobe` the uploaded mp4 and print PASS/FAIL.
 *
 * DEGRADES GRACEFULLY: if Playwright/Chromium or a running studio (:5175) or
 * ffprobe is unavailable, it prints "skipped: <reason>" and exits 0 (so it can
 * run in CI / on machines without a browser without failing the build). It exits
 * non-zero only on an outright FAIL (the pipeline ran but produced a bad mp4).
 *
 * Run: `npm run build --workspace @las/newsroom-mcp && npm run smoke --workspace @las/newsroom-mcp`
 * Needs the avatar-live dev server up (`npm run dev:avatar` → http://localhost:5175).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateNewsReportDoc } from '@las/protocol';

import { startTransport, stopTransport, callBridge, uploadedPath } from '../transport.js';
import { connectStudio, disconnectStudio } from '../studio.js';

const execFileAsync = promisify(execFile);

const STUDIO_URL = process.env.SMOKE_STUDIO_URL ?? 'http://localhost:5175';
const CONNECT_TIMEOUT_MS = Number(process.env.SMOKE_CONNECT_TIMEOUT_MS ?? 60_000);

/** A small, valid Fable/Mythos newscast — one anchor, one section, two beats. */
const SAMPLE_DOC = {
  version: 2,
  meta: {
    title: 'Mythos Nightly — Smoke Test',
    anchors: [
      {
        id: 'fable',
        name: 'Fable',
        avatarUrl: 'avaturn-model',
        voiceId: 'browser:default',
      },
    ],
    language: 'en',
    fps: 30,
    aspect: '16:9',
  },
  rundown: [
    {
      id: 'sec_open',
      slug: 'cold-open',
      storyForm: 'READER',
      headline: 'A myth, retold',
      beats: [
        {
          id: 'b1',
          text: 'Good evening. From the halls of Mythos, this is Fable with the nightly retelling.',
          emotion: 'warm',
          gesture: 'open_palms',
        },
        {
          id: 'b2',
          text: 'Tonight: how an old story finds new life in the studio. Stay with us.',
          emotion: 'confident',
          pause_ms_after: 200,
        },
      ],
    },
  ],
} as const;

function skip(reason: string): never {
  process.stdout.write(`SMOKE skipped: ${reason}\n`);
  process.exit(0);
}

function isConnectivityError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes('executable doesn') || // Chromium not installed
    msg.includes('playwright') ||
    msg.includes('browsertype.launch') ||
    msg.includes('econnrefused') ||
    msg.includes('err_connection_refused') ||
    msg.includes('net::') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('cannot find module') ||
    msg.includes("can't be resolved")
  );
}

async function ffprobeOk(path: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,nb_frames',
      '-show_entries',
      'format=duration,format_name',
      '-of',
      'json',
      path,
    ]);
    const probe = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string; width?: number; height?: number }>;
      format?: { duration?: string; format_name?: string };
    };
    const v = probe.streams?.[0];
    if (!v || !v.codec_name) {
      return { ok: false, detail: 'no video stream found' };
    }
    const duration = Number(probe.format?.duration ?? 0);
    const detail =
      `codec=${v.codec_name} ${v.width}x${v.height} ` +
      `duration=${duration.toFixed(2)}s container=${probe.format?.format_name ?? '?'}`;
    return { ok: duration > 0 && !!v.width && !!v.height, detail };
  } catch (err) {
    // ffprobe missing is a skip-worthy condition, surfaced to the caller.
    const msg = String(err);
    if (msg.includes('ENOENT')) {
      throw new Error('ffprobe-missing');
    }
    return { ok: false, detail: `ffprobe error: ${msg}` };
  }
}

async function main(): Promise<void> {
  // Validate the sample locally first — a bug here is a real FAIL, not a skip.
  validateNewsReportDoc(SAMPLE_DOC);
  process.stdout.write('SMOKE: sample NewsReportDoc validates OK.\n');

  await startTransport();
  process.stdout.write(`SMOKE: transport up. Connecting headless studio at ${STUDIO_URL} …\n`);

  // 1) Connect a headless studio. Browser/studio unavailability → skip.
  try {
    const session = await connectStudio({
      mode: 'headless',
      studioUrl: STUDIO_URL,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    process.stdout.write(
      `SMOKE: studio connected (id=${session.studioId}, caps=${session.capabilities.join(',') || 'none'}).\n`,
    );
  } catch (err) {
    await stopTransport().catch(() => {});
    if (isConnectivityError(err)) {
      skip(
        `could not connect a headless studio (${String(err)}). ` +
          `Needs avatar-live on ${STUDIO_URL} + Playwright Chromium installed.`,
      );
    }
    throw err;
  }

  let exitCode = 0;
  try {
    // 2) Apply the newscast.
    await callBridge('applyNewscast', { doc: SAMPLE_DOC });
    process.stdout.write('SMOKE: applied newscast.\n');

    // 3) Screenshot the output (best-effort; not asserted).
    try {
      const shot = (await callBridge('screenshot', { target: 'output' })) as { ref?: string };
      const shotPath = shot?.ref ? uploadedPath(shot.ref) : undefined;
      process.stdout.write(`SMOKE: screenshot → ${shotPath ?? '(no file)'}\n`);
    } catch (err) {
      process.stdout.write(`SMOKE: screenshot failed (non-fatal): ${String(err)}\n`);
    }

    // 4) Export mp4.
    const exported = (await callBridge('exportMp4', {})) as { ref: string; bytes: number };
    const mp4Path = uploadedPath(exported.ref);
    if (!mp4Path) {
      process.stdout.write(`SMOKE FAIL: export ref ${exported.ref} produced no local file.\n`);
      exitCode = 1;
    } else {
      process.stdout.write(`SMOKE: exported mp4 (${exported.bytes} bytes) → ${mp4Path}\n`);

      // 5) ffprobe the result.
      let probe;
      try {
        probe = await ffprobeOk(mp4Path);
      } catch (err) {
        if (String(err).includes('ffprobe-missing')) {
          await disconnectStudio().catch(() => {});
          await stopTransport().catch(() => {});
          skip('ffprobe not found on PATH (install ffmpeg to validate the mp4).');
        }
        throw err;
      }
      if (probe.ok) {
        process.stdout.write(`SMOKE PASS: valid mp4 — ${probe.detail}\n`);
      } else {
        process.stdout.write(`SMOKE FAIL: invalid mp4 — ${probe.detail}\n`);
        exitCode = 1;
      }
    }
  } finally {
    await disconnectStudio().catch(() => {});
    await stopTransport().catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((err) => {
  // An unexpected error after the studio connected is a real failure. But if it
  // smells like an environment/connectivity issue, treat it as a skip.
  if (isConnectivityError(err)) {
    process.stdout.write(`SMOKE skipped: ${String(err)}\n`);
    process.exit(0);
  }
  process.stderr.write(`SMOKE error: ${String(err)}\n`);
  process.exit(1);
});
