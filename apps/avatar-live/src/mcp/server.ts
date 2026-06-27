// StudioMcpServer — the in-page WebMCP server (design:
// docs/specs/2026-06-25-webmcp-studio-control-design.md).
//
// On load, registers the studio's tools with `navigator.modelContext` so ANY WebMCP-capable
// AI app attached to the tab can drive the studio — no out-of-process stdio MCP, no WS bridge
// relay. Each tool routes back through the SAME bridge dispatcher (`createDispatcher`) and
// validates against the SAME protocol zod params (in `buildStudioTools`), so the two surfaces
// share one command vocabulary. They are NOT byte-identical, though: the WebMCP adapter gates
// the `execute_js` arbitrary-eval hatch behind `?webmcp=full`, whereas the WS `?bridge=` channel
// (a 127.0.0.1-only dev relay) exposes it ungated. `execute_js` is the one capability that
// differs between the surfaces.
//
// SECURITY: registering tools exposes studio-state mutation (set_script, apply_newscast,
// set_avatar — which loads an arbitrary glTF URL, export_mp4 — which downloads a file) to
// whatever AI client is attached to the tab. That is the WebMCP model, but it is NOT a consent
// gate. For the POC/dev studio this is acceptable; a production deployment should add an
// explicit per-session opt-in before registering, and must keep `execute_js` (full origin
// access) off by default. The default tool set already excludes `execute_js`.
//
// OFF when the runtime has no `navigator.modelContext` (normal browsers — a harmless no-op) or
// it's explicitly disabled via `?webmcp=off` / `VITE_WEBMCP=off`. `?webmcp=full` additionally
// registers the `execute_js` escape hatch (opt-in; see the spec's §7) — do NOT make it the
// default launch URL.
import type { StudioContext } from '../app/context.js';
import { createDispatcher, screenshotBlob, exportBlob, type BridgeControllers } from '../bridge/dispatch.js';
import { buildStudioTools } from './tools.js';
import { getModelContext } from './types.js';

/** Resolve whether the WebMCP server is enabled and how. */
function resolveMode(): { enabled: boolean; allowExecuteJs: boolean } {
  const q = new URLSearchParams(location.search).get('webmcp');
  const env = (import.meta.env.VITE_WEBMCP as string | undefined) ?? undefined;
  const raw = (q ?? env)?.toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false') return { enabled: false, allowExecuteJs: false };
  // Present API ⇒ enabled by default; `full` opts into the eval escape hatch.
  return { enabled: true, allowExecuteJs: raw === 'full' };
}

/** Encode a Blob as base64 in fixed-size chunks (avoids a huge spread on btoa). */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Downscale a (PNG) screenshot blob to a compact JPEG for the see→verify loop. A full-res PNG
 * is multiple MB of base64 — too large to flow through an MCP client's tool-result budget (the
 * bridge JSON-stringifies the image content). A ~1280px JPEG is plenty to *verify* a frame, and
 * an order of magnitude smaller. The full-res PNG path is unchanged for the WS-bridge sink.
 */
async function downscaleToJpeg(
  png: Blob,
  maxWidth = 720,
  quality = 0.5,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(png);
  const scale = bmp.width > maxWidth ? maxWidth / bmp.width : 1;
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for screenshot downscale');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width, height };
}

/** Trigger a browser download of a blob under `filename`. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportFilename(app: StudioContext): string {
  const raw = app.dom.projectNameEl?.value?.trim();
  const slug = (raw || 'studio-export').replace(/[^\w.-]+/g, '_');
  return slug.endsWith('.mp4') ? slug : `${slug}.mp4`;
}

/**
 * Register the studio's WebMCP tools if the runtime supports it. Returns immediately; a no-op
 * when `navigator.modelContext` is absent or disabled.
 */
export function initWebMcp(app: StudioContext, controllers: BridgeControllers): void {
  const { enabled, allowExecuteJs } = resolveMode();
  if (!enabled) return;
  const mc = getModelContext();
  if (!mc) {
    // Not an error — most browsers don't ship WebMCP yet. Leave a breadcrumb only in dev.
    return;
  }

  const dispatch = createDispatcher(app, controllers);

  const tools = buildStudioTools({
    dispatch,
    allowExecuteJs,
    screenshot: async (params) => {
      const png = await screenshotBlob(app, controllers, params);
      // Return a compact JPEG inline — a full-res PNG overruns the MCP client's result budget.
      const { blob, width, height } = await downscaleToJpeg(png.blob);
      return { data: await blobToBase64(blob), mimeType: 'image/jpeg', width, height };
    },
    exportVideo: async () => {
      const blob = await exportBlob(controllers);
      const filename = exportFilename(app);
      downloadBlob(blob, filename);
      return { bytes: blob.size, filename };
    },
  });

  for (const tool of tools) mc.registerTool(tool);
  app.log(`webmcp: registered ${tools.length} studio tools on navigator.modelContext${allowExecuteJs ? ' (execute_js enabled)' : ''}`);
}
