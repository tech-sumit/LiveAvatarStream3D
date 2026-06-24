/**
 * Newsroom MCP — master render tool (task NM-10, Phase 3 / GPU tier).
 *
 * `render_master` submits the current newscast to the *production* GPU pipeline
 * via control-api and polls the job to a finished MP4 master in R2 — the same
 * path the scene editor's Render tab uses (`POST /api/engine-jobs` →
 * orchestrator runs TTS → `compileManifest` → engine-three render node).
 *
 * This is fundamentally different from `export_mp4` (the Tier-1 tool in
 * render.ts): that records the *browser's* canvas locally. `render_master`
 * hands the performance to an H100/L40S render node and returns the R2 master.
 *
 * Control-api contract (read from services/control-api/src/routes/{engine,jobs}.ts
 * + orchestrator.ts):
 *   - Submit:  POST {CONTROL_API_URL}/api/engine-jobs
 *              body { userId, spec: EngineRenderSpec }  →  Job { id, status, ... }
 *   - Poll:    GET  {CONTROL_API_URL}/api/jobs/{id}
 *              →  { job: { status, outputKey, error, ... }, events }
 *              terminal statuses: 'succeeded' | 'failed'
 *   - Output:  job.outputKey is the R2 key (e.g. job_xxx.mp4); the streamable
 *              master is GET {CONTROL_API_URL}/api/jobs/{id}/download.
 *
 * The `EngineRenderSpec` is assembled from a {@link NewsReportDoc} here and
 * validated against the protocol's `CreateEngineRenderJobRequest` before it is
 * sent — the heavy lifting (PerformanceManifest compilation) stays server-side
 * in the orchestrator (`compileManifest`); we do not duplicate it.
 *
 * DEGRADES GRACEFULLY: an unreachable control-api, a failed job, or an offline
 * GPU pod all return an `isError` ToolResult explaining the prerequisite
 * (a deployed control-api + a running pod) with the underlying error. The tool
 * never throws out of the handler, so the MCP server stays up.
 */

import { z } from 'zod';
import { ZodError } from 'zod';
import {
  CreateEngineRenderJobRequest,
  validateNewsReportDoc,
  type DocDefaults,
  type EngineRenderSpec,
  type NewsReportDoc,
  type Script,
  type ScriptSegment,
} from '@las/protocol';

import { defineTool, type ToolDef, type ToolResult } from '../server.js';
import { callBridge } from '../transport.js';

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

/**
 * Base control-api URL. Default is the deployed Worker (see CLAUDE.md +
 * docs/specs/2026-06-20-how-to-run.md). `wrangler dev` has isolated D1/R2 so a
 * local URL will not find cloned voices on the pod — point this at the deploy.
 */
const DEFAULT_CONTROL_API_URL = 'https://<your-worker>.workers.dev/api';

function controlApiUrl(): string {
  return (process.env.CONTROL_API_URL ?? DEFAULT_CONTROL_API_URL).replace(/\/+$/, '');
}

/** POC user, hardcoded across editor + web (see CLAUDE.md). */
const POC_USER_ID = 'demo-user';

/** Named 16:9 resolution presets the tool accepts in addition to {width,height}. */
const RESOLUTION_PRESETS: Record<string, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
  '2160p': { width: 3840, height: 2160 },
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

function errResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function okResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * The prerequisite blurb appended to every degradation path so the caller knows
 * what to stand up.
 */
const PREREQ =
  'render_master needs (1) a reachable control-api (set CONTROL_API_URL, default ' +
  `${DEFAULT_CONTROL_API_URL}) and (2) a running GPU pod the Worker can dispatch to ` +
  '(spawn one with scripts/gpu/spawn-pod.sh and confirm /engine-three/health). ' +
  'The browser-only Tier-1 export (export_mp4) does not need either.';

/** Resolve a resolution input (preset string or {width,height}) → {width,height}. */
function resolveResolution(
  input: string | { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') {
    const preset = RESOLUTION_PRESETS[input.toLowerCase()];
    if (!preset) {
      throw new Error(
        `unknown resolution preset "${input}" (use one of ${Object.keys(RESOLUTION_PRESETS).join(', ')}, or {width,height})`,
      );
    }
    return preset;
  }
  return input;
}

/**
 * Lower a {@link NewsReportDoc} into the DSL {@link Script} the engine pipeline
 * consumes: one {@link ScriptSegment} per beat, carrying emotion / gesture /
 * pause / per-beat camera straight through. This is *spec assembly*, not
 * manifest compilation — the orchestrator still compiles the PerformanceManifest
 * server-side via `compileManifest`.
 */
function docToScript(doc: NewsReportDoc): Script {
  const defaults: Partial<DocDefaults> = doc.defaults ?? {};
  const segments: ScriptSegment[] = [];
  let seq = 0;
  for (const section of doc.rundown) {
    const sectionCamera = section.cameraDefault ?? defaults.camera;
    for (const beat of section.beats) {
      segments.push({
        seq: seq++,
        text: beat.text,
        emotion: beat.emotion ?? defaults.emotion ?? 'neutral',
        gesture: beat.gesture ?? defaults.gesture ?? 'none',
        posture: 'neutral',
        emphasis: [],
        pause_ms_after: beat.pause_ms_after ?? defaults.pause_ms_after ?? 0,
        camera: beat.camera ?? sectionCamera,
      });
    }
  }
  if (segments.length === 0) {
    // rundown is min(1) and beats is min(1) per schema, so this is defensive only.
    throw new Error('newscast has no beats to render');
  }
  return { version: 1, language: doc.meta.language ?? 'en', segments };
}

/**
 * Build the engine_render spec for a newscast. The avatar + voice come from the
 * first anchor; fps from meta; the cinematic "look" is forwarded when present.
 */
function docToEngineSpec(
  doc: NewsReportDoc,
  resolution: { width: number; height: number } | undefined,
): EngineRenderSpec {
  const anchor = doc.meta.anchors[0]!; // anchors is min(1) per schema
  return {
    avatarId: anchor.avatarUrl,
    voiceId: anchor.voiceId,
    script: docToScript(doc),
    stage: { level: 'L_Stage', lighting: 'three_point_warm' },
    fps: doc.meta.fps,
    resolution: resolution ?? { width: 1920, height: 1080 },
    look: doc.look,
  };
}

/**
 * Read the studio's live newscast doc over the bridge. Tries `executeJs` to
 * pull the in-memory `__las` newscast first; falls back to `getState`'s scalar
 * fields wrapped into a one-beat doc when no structured doc is exposed.
 */
async function readLiveDoc(): Promise<NewsReportDoc> {
  // 1) Preferred: the studio keeps the last-applied NewsReportDoc on __las.
  try {
    const raw = await callBridge<unknown>('executeJs', {
      code: 'return __las && (__las.newscast || __las.lastNewscast || (__las.projects && __las.projects.currentDoc)) || null;',
    });
    if (raw && typeof raw === 'object') {
      return validateNewsReportDoc(raw);
    }
  } catch {
    /* fall through to getState */
  }

  // 2) Fallback: assemble a minimal one-section doc from the state snapshot.
  const state = (await callBridge<Record<string, unknown>>('getState', {})) ?? {};
  const script = typeof state.script === 'string' ? state.script.trim() : '';
  const voiceId = typeof state.voiceId === 'string' ? state.voiceId : '';
  const avatarUrl = typeof state.avatar === 'string' ? state.avatar : '';
  const headline = typeof state.headline === 'string' ? state.headline : 'Newscast';
  if (!script) throw new Error('studio has no script loaded (getState.script is empty)');
  if (!voiceId) throw new Error('studio has no voice selected (getState.voiceId is empty)');
  if (!avatarUrl) throw new Error('studio has no avatar selected (getState.avatar is empty)');

  const doc = {
    version: 2 as const,
    meta: {
      title: headline,
      anchors: [{ id: 'anchor-1', name: 'Anchor', avatarUrl, voiceId }],
    },
    rundown: [
      {
        id: 'sec-1',
        slug: 'main',
        headline,
        beats: [{ id: 'beat-1', text: script }],
      },
    ],
  };
  // Round-trip through the protocol validator so defaults (fps, rate, emotion…)
  // are applied exactly as the rest of the pipeline expects.
  return validateNewsReportDoc(doc);
}

// ---------------------------------------------------------------------------
// HTTP helpers (graceful — surface a clear error instead of throwing raw).
// ---------------------------------------------------------------------------

interface JobResponse {
  id: string;
  status: string;
  outputKey?: string;
  error?: string;
}

async function postEngineJob(api: string, spec: EngineRenderSpec): Promise<JobResponse> {
  const body = CreateEngineRenderJobRequest.parse({ userId: POC_USER_ID, spec });
  const res = await fetch(`${api}/api/engine-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /api/engine-jobs -> ${res.status}: ${text.slice(0, 600)}`);
  }
  return JSON.parse(text) as JobResponse;
}

async function getJob(api: string, jobId: string): Promise<JobResponse> {
  const res = await fetch(`${api}/api/jobs/${jobId}`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET /api/jobs/${jobId} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { job?: JobResponse };
  if (!parsed.job) throw new Error(`malformed job response: ${text.slice(0, 200)}`);
  return parsed.job;
}

/** Poll a job to a terminal status, returning the final job row. */
async function pollJob(
  api: string,
  jobId: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<JobResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = '';
  for (;;) {
    const job = await getJob(api, jobId);
    if (job.status !== last) {
      process.stderr.write(`[newsroom-mcp] render_master ${jobId}: ${job.status}\n`);
      last = job.status;
    }
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      throw new Error(`render job failed: ${job.error ?? 'no error detail'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `render job did not finish within ${Math.round(opts.timeoutMs / 1000)}s ` +
          `(last status "${job.status}"). The pod may be cold-starting or offline.`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

// ---------------------------------------------------------------------------
// render_master.
// ---------------------------------------------------------------------------

const renderMaster = defineTool({
  name: 'render_master',
  title: 'Render a production master (GPU tier)',
  description:
    'Submit the newscast to the PRODUCTION GPU pipeline via control-api and poll ' +
    'until a finished MP4 master is in R2. Unlike export_mp4 (which records the ' +
    "browser canvas locally), this runs TTS + the Three.js engine-three render " +
    'node on a GPU pod. Provide a full NewsReportDoc as `doc`, or omit it to ' +
    "render the studio's current live newscast. Requires a deployed control-api " +
    '(CONTROL_API_URL) and a running GPU pod; degrades gracefully with a clear ' +
    'error if either is unavailable. Returns the master MP4 download URL (R2).',
  inputSchema: {
    doc: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'A full NewsReportDoc (version 2). Omit to render the studio\'s current live newscast.',
      ),
    resolution: z
      .union([
        z.enum(['1080p', '1440p', '4k', '2160p']),
        z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
      ])
      .optional()
      .describe('Output resolution: a preset ("1080p" | "1440p" | "4k") or {width,height}. Default 1080p.'),
    timeoutSeconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe('Max time to poll for the render to finish (default 1200s = 20min).'),
  },
  async handler({ doc, resolution, timeoutSeconds }): Promise<ToolResult> {
    const api = controlApiUrl();

    // 1) Resolve the newscast doc (provided, or read live from the studio).
    let newsDoc: NewsReportDoc;
    try {
      if (doc) {
        newsDoc = validateNewsReportDoc(doc);
      } else {
        newsDoc = await readLiveDoc();
      }
    } catch (err) {
      const msg = err instanceof ZodError ? formatZodError(err) : String(err);
      return errResult(
        `Could not obtain a newscast to render: ${msg}\n\n` +
          'Pass a valid NewsReportDoc as `doc`, or connect a studio (connect_studio) ' +
          'with a script + voice + avatar loaded.',
      );
    }

    // 2) Assemble + validate the engine_render spec.
    let spec: EngineRenderSpec;
    try {
      spec = docToEngineSpec(newsDoc, resolveResolution(resolution));
    } catch (err) {
      return errResult(`Could not build the render spec: ${String(err)}`);
    }

    // 3) Submit to control-api.
    let job: JobResponse;
    try {
      job = await postEngineJob(api, spec);
    } catch (err) {
      const msg = err instanceof ZodError ? formatZodError(err) : String(err);
      return errResult(
        `Failed to submit the render job to control-api at ${api}.\n${msg}\n\n${PREREQ}`,
      );
    }

    // 4) Poll to a terminal status.
    let finished: JobResponse;
    try {
      finished = await pollJob(api, job.id, {
        timeoutMs: (timeoutSeconds ?? 1200) * 1000,
        intervalMs: 8000,
      });
    } catch (err) {
      return errResult(
        `Render job ${job.id} did not complete.\n${String(err)}\n\n` +
          `Inspect it: GET ${api}/api/jobs/${job.id}\n\n${PREREQ}`,
      );
    }

    // 5) Return the master output URL (R2).
    const downloadUrl = `${api}/api/jobs/${finished.id}/download`;
    return okResult(
      `Master render complete.\n` +
        `job: ${finished.id}\n` +
        `outputKey (R2): ${finished.outputKey ?? '(missing)'}\n` +
        `download: ${downloadUrl}\n` +
        `title: ${newsDoc.meta.title}  ·  ${spec.resolution!.width}x${spec.resolution!.height} @ ${spec.fps}fps`,
    );
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const masterTools: ToolDef<any>[] = [renderMaster];
