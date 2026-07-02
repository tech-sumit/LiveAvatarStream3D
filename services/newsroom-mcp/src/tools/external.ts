/**
 * Newsroom MCP — external media generation tools (task NM-9, Phase 2).
 *
 * Two tools that call an *external* provider's HTTP API, save the generated
 * media into the transport work dir, register it as a served asset, and return
 * the served URL (`assetUrl` from NM-7) + local path:
 *
 *   - `generate_image` (prompt, ratio?) — Runway Dev API text→image. POSTs a
 *     `text_to_image` task, polls the task to SUCCEEDED, downloads the result.
 *   - `generate_audio` (prompt, durationSec?) — an env-configured audio/music
 *     provider. Default ElevenLabs (sound-generation), or a generic
 *     `AUDIO_API_URL` + `AUDIO_API_KEY` endpoint.
 *
 * Each provider call lives in a small, swappable `client` function so the
 * provider/endpoint is easy to change (the model id / API base / header are
 * plain constants at the top of each client block).
 *
 * DEGRADES GRACEFULLY: every failure mode returns an `isError` ToolResult — it
 * never throws out of the handler, so the MCP server stays up. In particular:
 *   - a MISSING API key env var → an `isError` result that names the exact env
 *     var to set and what the tool *would* have done (no crash);
 *   - an HTTP / poll error → an `isError` result carrying the provider's status
 *     and message.
 */

import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { defineTool, type ToolDef, type ToolResult } from '../server.js';
import { assetUrl, registerAsset, workDir } from '../assets/serve.js';

// ---------------------------------------------------------------------------
// Small result helpers.
// ---------------------------------------------------------------------------

function errResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function okResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A successful generation: where it landed locally + the served URL. */
interface SavedAsset {
  path: string;
  assetId: string;
  url: string;
}

/**
 * Write bytes into the transport work dir under a fresh id, register them as a
 * served asset, and return the local path + served URL. The extension is taken
 * from `ext` (or inferred from a content-type) so the HTTP server serves the
 * right content-type.
 */
async function saveAsset(bytes: Uint8Array, ext: string): Promise<SavedAsset> {
  const clean = ext.replace(/^\./, '').toLowerCase() || 'bin';
  const path = join(workDir(), `${randomUUID()}.${clean}`);
  await writeFile(path, bytes);
  const assetId = registerAsset(path);
  return { path, assetId, url: assetUrl(assetId) };
}

/** Map a response content-type to a file extension (best-effort). */
function extFromContentType(ct: string | null, fallback: string): string {
  if (!ct) return fallback;
  const type = ct.split(';')[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  };
  return map[type] ?? fallback;
}

/** Derive an extension from a URL's path, falling back to `fallback`. */
function extFromUrl(url: string, fallback: string): string {
  try {
    const p = new URL(url).pathname;
    const e = extname(p).replace(/^\./, '').toLowerCase();
    return e || fallback;
  } catch {
    return fallback;
  }
}

/** Download a URL's bytes; throws with a clear message on a non-2xx. */
async function downloadBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`download ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get('content-type') };
}

// ===========================================================================
// generate_image — Runway Dev API (text → image).
// ===========================================================================

/**
 * Runway Dev API client. Swap the provider by replacing this function — keep
 * the `(prompt, ratio) => imageUrl` contract.
 *
 * Endpoint shape (Runway Dev API, https://docs.dev.runwayml.com):
 *   - POST {RUNWAY_API_BASE}/text_to_image
 *       headers: Authorization: Bearer <RUNWAY_API_KEY>, X-Runway-Version: <ver>
 *       body:    { promptText, ratio, model }
 *       → 200 { id }                        (a task id)
 *   - GET  {RUNWAY_API_BASE}/tasks/{id}
 *       → { status: 'PENDING'|'RUNNING'|'SUCCEEDED'|'FAILED', output?: string[], failure? }
 *
 * The base URL, model id, API version and endpoint paths are constants so they
 * are trivial to retarget if Runway revs the API.
 */
const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE ?? 'https://api.dev.runwayml.com/v1';
const RUNWAY_API_VERSION = process.env.RUNWAY_API_VERSION ?? '2024-11-06';
const RUNWAY_IMAGE_MODEL = process.env.RUNWAY_IMAGE_MODEL ?? 'gen4_image';
const RUNWAY_TEXT_TO_IMAGE_PATH = '/text_to_image';
const RUNWAY_TASKS_PATH = '/tasks';

interface RunwayTask {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'THROTTLED' | 'SUCCEEDED' | 'FAILED' | string;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

function runwayHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Runway-Version': RUNWAY_API_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Submit a text→image task and poll it to completion, returning the result
 * image URL. Throws (with a provider-derived message) on HTTP / task failure or
 * if the poll budget elapses; the caller wraps that into an `isError` result.
 */
async function runwayGenerateImage(
  apiKey: string,
  prompt: string,
  ratio: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<string> {
  // 1) Submit the task.
  const submitRes = await fetch(`${RUNWAY_API_BASE}${RUNWAY_TEXT_TO_IMAGE_PATH}`, {
    method: 'POST',
    headers: runwayHeaders(apiKey),
    body: JSON.stringify({ promptText: prompt, ratio, model: RUNWAY_IMAGE_MODEL }),
  });
  const submitText = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(
      `Runway POST ${RUNWAY_TEXT_TO_IMAGE_PATH} -> ${submitRes.status} ${submitRes.statusText}: ${submitText.slice(0, 400)}`,
    );
  }
  let submitted: { id?: string };
  try {
    submitted = JSON.parse(submitText) as { id?: string };
  } catch {
    throw new Error(`Runway returned non-JSON task response: ${submitText.slice(0, 200)}`);
  }
  const taskId = submitted.id;
  if (!taskId) throw new Error(`Runway task response had no id: ${submitText.slice(0, 200)}`);

  // 2) Poll the task to a terminal status.
  const deadline = Date.now() + opts.timeoutMs;
  let last = '';
  for (;;) {
    const res = await fetch(`${RUNWAY_API_BASE}${RUNWAY_TASKS_PATH}/${taskId}`, {
      headers: runwayHeaders(apiKey),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Runway GET ${RUNWAY_TASKS_PATH}/${taskId} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      );
    }
    let task: RunwayTask;
    try {
      task = JSON.parse(text) as RunwayTask;
    } catch {
      throw new Error(`Runway returned non-JSON task status: ${text.slice(0, 200)}`);
    }
    if (task.status !== last) {
      process.stderr.write(`[newsroom-mcp] generate_image ${taskId}: ${task.status}\n`);
      last = task.status;
    }
    if (task.status === 'SUCCEEDED') {
      const url = task.output?.[0];
      if (!url) throw new Error('Runway task SUCCEEDED but had no output image url');
      return url;
    }
    if (task.status === 'FAILED') {
      throw new Error(`Runway task failed: ${task.failure ?? task.failureCode ?? 'no detail'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Runway task ${taskId} did not finish within ${Math.round(opts.timeoutMs / 1000)}s (last status "${task.status}")`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

const generateImage = defineTool({
  name: 'generate_image',
  title: 'Generate an image (Runway text→image)',
  description:
    'Generate an image from a text prompt with the Runway Dev API (text_to_image: ' +
    'submit a task, poll to SUCCEEDED, download the result). The image is saved ' +
    'to the work dir and served locally; returns the asset URL + path. Requires ' +
    'RUNWAY_API_KEY — if it is unset the tool degrades gracefully and tells you ' +
    'which env var to set (it does not crash).',
  inputSchema: {
    prompt: z.string().min(1).describe('Text prompt describing the image to generate.'),
    ratio: z
      .string()
      .optional()
      .describe(
        'Aspect ratio "W:H" (Runway preset, e.g. 1920:1080, 1080:1920, 1024:1024). Default 1920:1080.',
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(900)
      .optional()
      .describe('Max time to poll for the image to finish (default 180s).'),
  },
  async handler({ prompt, ratio, timeoutSeconds }): Promise<ToolResult> {
    const apiKey = process.env.RUNWAY_API_KEY;
    if (!apiKey) {
      return errResult(
        'generate_image is not configured: set the RUNWAY_API_KEY environment variable ' +
          '(a Runway Dev API key from https://dev.runwayml.com). With it set, this tool ' +
          'submits a Runway text_to_image task for your prompt, polls it to completion, ' +
          'downloads the generated image, saves it to the work dir, and returns a served ' +
          'asset URL + local path. (Optional overrides: RUNWAY_API_BASE, RUNWAY_API_VERSION, ' +
          'RUNWAY_IMAGE_MODEL.)',
      );
    }

    const useRatio = ratio?.trim() || '1920:1080';

    // 1) Generate via the provider client (image URL).
    let imageUrl: string;
    try {
      imageUrl = await runwayGenerateImage(apiKey, prompt, useRatio, {
        timeoutMs: (timeoutSeconds ?? 180) * 1000,
        intervalMs: 4000,
      });
    } catch (err) {
      return errResult(`Runway image generation failed: ${String(err)}`);
    }

    // 2) Download + save + register.
    try {
      const { bytes, contentType } = await downloadBytes(imageUrl);
      const ext = extFromContentType(contentType, extFromUrl(imageUrl, 'png'));
      const saved = await saveAsset(bytes, ext);
      return okResult(
        `Image generated.\n` +
          `prompt: ${prompt}\n` +
          `ratio: ${useRatio}  ·  model: ${RUNWAY_IMAGE_MODEL}\n` +
          `url: ${saved.url}\n` +
          `path: ${saved.path}\n` +
          `assetId: ${saved.assetId}`,
      );
    } catch (err) {
      return errResult(
        `Runway image generated (${imageUrl}) but could not be downloaded/saved: ${String(err)}`,
      );
    }
  },
});

// ===========================================================================
// generate_audio — env-configured audio/music provider.
// ===========================================================================

/**
 * ElevenLabs sound-generation client (the default audio provider). Swap the
 * provider by replacing this function or by setting AUDIO_API_URL/AUDIO_API_KEY
 * (the generic client below). Keep the `(prompt, durationSec) => audio bytes`
 * contract.
 *
 * Endpoint (https://elevenlabs.io/docs — Sound Generation):
 *   POST {ELEVENLABS_API_BASE}/sound-generation
 *     headers: xi-api-key: <ELEVENLABS_API_KEY>
 *     body:    { text, duration_seconds? }
 *     → 200 audio bytes (audio/mpeg)
 */
const ELEVENLABS_API_BASE = process.env.ELEVENLABS_API_BASE ?? 'https://api.elevenlabs.io/v1';
const ELEVENLABS_SOUND_PATH = '/sound-generation';

async function elevenLabsGenerateAudio(
  apiKey: string,
  prompt: string,
  durationSec: number | undefined,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const body: Record<string, unknown> = { text: prompt };
  if (durationSec != null) body.duration_seconds = durationSec;
  const res = await fetch(`${ELEVENLABS_API_BASE}${ELEVENLABS_SOUND_PATH}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ElevenLabs POST ${ELEVENLABS_SOUND_PATH} -> ${res.status} ${res.statusText}: ${text.slice(0, 400)}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') };
}

/**
 * Generic audio provider client: POST the prompt to AUDIO_API_URL with a Bearer
 * AUDIO_API_KEY and read back audio bytes. Lets you point generate_audio at any
 * compatible sound/music endpoint without touching code.
 */
async function genericGenerateAudio(
  apiUrl: string,
  apiKey: string,
  prompt: string,
  durationSec: number | undefined,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const body: Record<string, unknown> = { prompt };
  if (durationSec != null) body.duration_seconds = durationSec;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AUDIO_API_URL POST -> ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') };
}

const generateAudio = defineTool({
  name: 'generate_audio',
  title: 'Generate audio / music from a prompt',
  description:
    'Generate audio (a sound bed / music / SFX) from a text prompt via an ' +
    'env-configured provider. Default: ElevenLabs sound-generation ' +
    '(ELEVENLABS_API_KEY). Alternatively set a generic AUDIO_API_URL + ' +
    'AUDIO_API_KEY to use any compatible endpoint. The audio is saved to the ' +
    'work dir and served locally; returns the asset URL + path. Degrades ' +
    'gracefully (names the env var to set) if no provider is configured.',
  inputSchema: {
    prompt: z.string().min(1).describe('Text prompt describing the audio to generate.'),
    durationSec: z
      .number()
      .positive()
      .max(300)
      .optional()
      .describe('Desired duration in seconds (provider-dependent; omit to let the provider decide).'),
  },
  async handler({ prompt, durationSec }): Promise<ToolResult> {
    const genericUrl = process.env.AUDIO_API_URL;
    const genericKey = process.env.AUDIO_API_KEY;
    const elevenKey = process.env.ELEVENLABS_API_KEY;

    // Pick a provider: explicit generic endpoint wins, else ElevenLabs default.
    let provider: 'generic' | 'elevenlabs';
    if (genericUrl) {
      if (!genericKey) {
        return errResult(
          'generate_audio: AUDIO_API_URL is set but AUDIO_API_KEY is missing. Set ' +
            'AUDIO_API_KEY (the bearer token for your audio endpoint). With both set, this ' +
            'tool POSTs { prompt, duration_seconds } to AUDIO_API_URL, reads back the audio ' +
            'bytes, saves them to the work dir, and returns a served asset URL + path.',
        );
      }
      provider = 'generic';
    } else if (elevenKey) {
      provider = 'elevenlabs';
    } else {
      return errResult(
        'generate_audio is not configured: set ELEVENLABS_API_KEY (default provider — ' +
          'ElevenLabs sound-generation), OR set a generic AUDIO_API_URL + AUDIO_API_KEY ' +
          'to use any compatible audio endpoint. With a provider configured, this tool ' +
          'generates audio for your prompt, saves it to the work dir, and returns a served ' +
          'asset URL + local path. (Optional override: ELEVENLABS_API_BASE.)',
      );
    }

    // 1) Generate via the chosen provider client.
    let result: { bytes: Uint8Array; contentType: string | null };
    try {
      if (provider === 'generic') {
        result = await genericGenerateAudio(genericUrl!, genericKey!, prompt, durationSec);
      } else {
        result = await elevenLabsGenerateAudio(elevenKey!, prompt, durationSec);
      }
    } catch (err) {
      return errResult(`Audio generation failed (${provider}): ${String(err)}`);
    }

    // 2) Save + register.
    try {
      const ext = extFromContentType(result.contentType, provider === 'generic' ? 'mp3' : 'mp3');
      const saved = await saveAsset(result.bytes, ext);
      return okResult(
        `Audio generated.\n` +
          `prompt: ${prompt}\n` +
          `provider: ${provider}${durationSec != null ? `  ·  ~${durationSec}s` : ''}\n` +
          `url: ${saved.url}\n` +
          `path: ${saved.path}\n` +
          `assetId: ${saved.assetId}`,
      );
    } catch (err) {
      return errResult(`Audio generated but could not be saved: ${String(err)}`);
    }
  },
});

// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const externalTools: ToolDef<any>[] = [generateImage, generateAudio];
