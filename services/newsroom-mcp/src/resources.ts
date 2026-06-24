/**
 * Newsroom MCP — catalog + studio resources (task NM-6).
 *
 * Read-only MCP resources that let a client discover the studio's vocabulary
 * (cues, emotions, gestures, look/lighting presets) and inspect live studio
 * state (connected avatars, voices, current scene). Resources are addressed by
 * `newsroom://...` URIs and always return `application/json`.
 *
 * The CATALOG resources are *static* — sourced from the `@las/protocol` enums
 * (the single source of truth for the DSL/bridge vocabulary). The cue keys are
 * inlined here on purpose: the live cue catalog lives in `apps/avatar-live`
 * (browser code that imports `three`), and importing it into this Node service
 * would drag a browser dependency onto the MCP startup path. The keys below
 * mirror `apps/avatar-live/src/timeline/catalog.ts` — keep them in sync if that
 * catalog grows.
 *
 * The STUDIO resources are *live* — they round-trip `getState` over the bridge
 * and degrade gracefully (return a JSON note) when no studio is connected.
 *
 * This module does NOT touch `server.ts`: the orchestrator calls
 * `registerResources(server)` inside `createServer`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  EMOTIONS,
  GESTURES,
  POSTURES,
  CAMERA_SHOTS,
  CAMERA_MOVES,
  CAMERA_TARGETS,
  CAMERA_EASINGS,
  BRIDGE_LOOK_PRESETS,
  BRIDGE_LIGHTING_PRESETS,
  BRIDGE_CAPTURE_RESOLUTIONS,
  BRIDGE_CAPTURE_CODECS,
} from '@las/protocol';

import { callBridge, hasStudio } from './transport.js';

// ---------------------------------------------------------------------------
// Static catalog data.
// ---------------------------------------------------------------------------

/**
 * Camera cue keys — mirrored from `apps/avatar-live/src/timeline/catalog.ts`
 * (the `cam.*` entries of its CATALOG). Inlined to avoid importing browser code.
 */
const CAMERA_CUE_TYPES = [
  'cam.enterLeft',
  'cam.wide',
  'cam.anchor',
  'cam.close',
  'cam.screen',
  'cam.orbit',
  'cam.custom',
  'cam.path',
  'cam.screenSource',
] as const;

/**
 * Motion/gesture cue keys — mirrored from the `motion.*` entries of the
 * avatar-live CATALOG. Inlined to avoid importing browser code.
 */
const MOTION_CUE_TYPES = [
  'motion.turnScreen',
  'motion.faceFront',
  'motion.point',
  'motion.wave',
  'motion.nod',
  'motion.explain',
] as const;

/** Read-only JSON content helper for a resource handler. */
function jsonContents(uri: string, data: unknown): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// registerResources.
// ---------------------------------------------------------------------------

/**
 * Register the read-only newsroom resources on the MCP server. Called by the
 * orchestrator from `createServer` (do not call from `server.ts` directly here).
 */
export function registerResources(server: McpServer): void {
  // ── newsroom://catalog/cues ───────────────────────────────────────────────
  server.registerResource(
    'catalog-cues',
    'newsroom://catalog/cues',
    {
      title: 'Cue catalog',
      description:
        'Camera shots/moves (from @las/protocol) plus the studio cue keys: ' +
        'camera (cam.*) and motion/gesture (motion.*) cue types.',
      mimeType: 'application/json',
    },
    (uri) =>
      jsonContents(uri.href, {
        cameraShots: CAMERA_SHOTS,
        cameraMoves: CAMERA_MOVES,
        cameraTargets: CAMERA_TARGETS,
        cameraEasings: CAMERA_EASINGS,
        cameraCueTypes: CAMERA_CUE_TYPES,
        motionCueTypes: MOTION_CUE_TYPES,
      }),
  );

  // ── newsroom://catalog/emotions ───────────────────────────────────────────
  server.registerResource(
    'catalog-emotions',
    'newsroom://catalog/emotions',
    {
      title: 'Emotion vocabulary',
      description: 'The enumerated emotion values (from @las/protocol EMOTIONS).',
      mimeType: 'application/json',
    },
    (uri) => jsonContents(uri.href, { emotions: EMOTIONS }),
  );

  // ── newsroom://catalog/gestures ───────────────────────────────────────────
  server.registerResource(
    'catalog-gestures',
    'newsroom://catalog/gestures',
    {
      title: 'Gesture vocabulary',
      description:
        'The enumerated gesture values (from @las/protocol GESTURES), plus body postures.',
      mimeType: 'application/json',
    },
    (uri) => jsonContents(uri.href, { gestures: GESTURES, postures: POSTURES }),
  );

  // ── newsroom://catalog/presets ────────────────────────────────────────────
  server.registerResource(
    'catalog-presets',
    'newsroom://catalog/presets',
    {
      title: 'Look / lighting / capture presets',
      description:
        'Look presets (broadcast/flat/cinematic/warm/noir), lighting presets ' +
        '(studio/soft/dramatic/warm/cool), and capture resolutions/codecs.',
      mimeType: 'application/json',
    },
    (uri) =>
      jsonContents(uri.href, {
        lookPresets: BRIDGE_LOOK_PRESETS,
        lightingPresets: BRIDGE_LIGHTING_PRESETS,
        captureResolutions: BRIDGE_CAPTURE_RESOLUTIONS,
        captureCodecs: BRIDGE_CAPTURE_CODECS,
      }),
  );

  // ── Live studio resources (best-effort via the bridge). ───────────────────

  /**
   * Round-trip `getState` over the bridge, returning the full state object or a
   * structured note when no studio is connected / the call fails. Never throws.
   */
  async function getStudioState(): Promise<{ connected: boolean; note?: string; state?: unknown }> {
    if (!hasStudio()) {
      return {
        connected: false,
        note:
          'No studio connected. Connect one first (call the connect_studio tool, ' +
          'or open avatar-live with ?bridge=9777), then re-read this resource.',
      };
    }
    try {
      const state = await callBridge('getState', {});
      return { connected: true, state };
    } catch (err) {
      return { connected: false, note: `getState failed: ${String(err)}` };
    }
  }

  // ── newsroom://studio/state ───────────────────────────────────────────────
  server.registerResource(
    'studio-state',
    'newsroom://studio/state',
    {
      title: 'Live studio state',
      description:
        'The connected studio\'s current state (the full getState payload: scene, ' +
        'avatars, voices, lighting, the loaded newscast, etc.). Requires a connected studio.',
      mimeType: 'application/json',
    },
    async (uri) => jsonContents(uri.href, await getStudioState()),
  );

  // ── newsroom://studio/avatars ─────────────────────────────────────────────
  server.registerResource(
    'studio-avatars',
    'newsroom://studio/avatars',
    {
      title: 'Available avatars',
      description:
        'Avatars known to the connected studio (derived from its live getState). ' +
        'Requires a connected studio.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const s = await getStudioState();
      if (!s.connected) return jsonContents(uri.href, s);
      const state = s.state as Record<string, unknown> | undefined;
      const avatars = state?.avatars ?? state?.avatarList ?? null;
      return jsonContents(uri.href, {
        connected: true,
        avatars,
        ...(avatars == null
          ? { note: 'The studio getState payload did not include an avatars field.' }
          : {}),
      });
    },
  );

  // ── newsroom://studio/voices ──────────────────────────────────────────────
  server.registerResource(
    'studio-voices',
    'newsroom://studio/voices',
    {
      title: 'Available voices',
      description:
        'Voices known to the connected studio (derived from its live getState). ' +
        'Requires a connected studio.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const s = await getStudioState();
      if (!s.connected) return jsonContents(uri.href, s);
      const state = s.state as Record<string, unknown> | undefined;
      const voices = state?.voices ?? state?.voiceList ?? null;
      return jsonContents(uri.href, {
        connected: true,
        voices,
        ...(voices == null
          ? { note: 'The studio getState payload did not include a voices field.' }
          : {}),
      });
    },
  );
}
