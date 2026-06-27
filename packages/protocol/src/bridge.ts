import { z } from 'zod';
import { Emotion, CameraShot, CameraMove } from './dsl.js';

/**
 * Studio Bridge WS protocol.
 *
 * This is the single source of truth for the WebSocket control channel between
 * an avatar-live "studio" (the browser app that owns the live Three.js scene)
 * and a remote driver such as the Newsroom MCP server. Both ends import these
 * schemas: the studio validates inbound {@link BridgeCommand} requests and
 * replies with {@link BridgeResult}; the MCP server builds requests and parses
 * results.
 *
 * Design notes:
 * - Commands are a discriminated union on the `cmd` literal. Each command
 *   carries its own `params` object.
 * - Params stay permissive where the studio itself does the heavy validation
 *   (e.g. a whole newscast `doc` is `z.unknown()` — the studio re-validates it as a
 *   `Score` via `validateScore`, or auto-lowers a legacy `NewsReportDoc` through
 *   `compileNewsReportToScore`). Simple scalars are strict.
 * - Existing protocol enums are reused so the vocabulary cannot drift:
 *   {@link Emotion}, {@link CameraShot}, {@link CameraMove}.
 */

// ---------------------------------------------------------------------------
// Shared vocabularies (mirrored from the avatar-live studio controllers).
// ---------------------------------------------------------------------------

/** Lighting presets exposed by the studio's lighting controller. */
export const BRIDGE_LIGHTING_PRESETS = ['studio', 'soft', 'dramatic', 'warm', 'cool'] as const;
export const BridgeLightingPreset = z.enum(BRIDGE_LIGHTING_PRESETS);
export type BridgeLightingPreset = z.infer<typeof BridgeLightingPreset>;

/** Cinematic "look" presets (mirror PostProcessingSpec.preset). */
export const BRIDGE_LOOK_PRESETS = ['broadcast', 'flat', 'cinematic', 'warm', 'noir'] as const;
export const BridgeLookPreset = z.enum(BRIDGE_LOOK_PRESETS);
export type BridgeLookPreset = z.infer<typeof BridgeLookPreset>;

/** Capture resolution presets offered by the studio recorder. */
export const BRIDGE_CAPTURE_RESOLUTIONS = ['720p', '1080p', '4k', 'vertical', 'square'] as const;
export const BridgeCaptureResolution = z.enum(BRIDGE_CAPTURE_RESOLUTIONS);
export type BridgeCaptureResolution = z.infer<typeof BridgeCaptureResolution>;

/** Export codecs offered by the studio recorder. */
export const BRIDGE_CAPTURE_CODECS = ['avc', 'hevc'] as const;
export const BridgeCaptureCodec = z.enum(BRIDGE_CAPTURE_CODECS);
export type BridgeCaptureCodec = z.infer<typeof BridgeCaptureCodec>;

/** Timeline tracks a cue can live on. */
export const BRIDGE_CUE_TRACKS = ['camera', 'gesture', 'emotion', 'audio', 'event'] as const;
export const BridgeCueTrack = z.enum(BRIDGE_CUE_TRACKS);
export type BridgeCueTrack = z.infer<typeof BridgeCueTrack>;

/** Screenshot capture targets. */
export const BridgeScreenshotTarget = z.enum(['viewport', 'output']);
export type BridgeScreenshotTarget = z.infer<typeof BridgeScreenshotTarget>;

// ---------------------------------------------------------------------------
// Per-command params.
// ---------------------------------------------------------------------------

/**
 * A studio validates the doc itself, so the bridge keeps it opaque.
 *
 * Since Phase 5 the studio validates `doc` as a {@link Score} (via `validateScore`)
 * and lands the compiled `Performance` in its `ScoreDrive`. A legacy `NewsReportDoc`
 * is still accepted: the dispatcher auto-lowers it through `compileNewsReportToScore`
 * onto the SAME Score runtime. The envelope is unchanged — `doc` stays `z.unknown()`
 * so either shape is accepted on the wire and validated by the studio.
 */
const NewscastDocParams = z.object({ doc: z.unknown() });
const NewscastPatchParams = z.object({ patch: z.unknown() });

const SetScriptParams = z.object({ script: z.string() });

const SetVoiceParams = z.object({
  voiceId: z.string().min(1),
  rate: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
});

const SetAvatarParams = z.object({ avatar: z.string().min(1) });

const SetEmotionParams = z.object({ emotion: Emotion });

/**
 * Either a named lighting preset, or explicit per-channel values. Both keys are
 * optional so a caller can nudge a single channel; the studio fills the rest.
 */
const SetLightingParams = z.object({
  preset: BridgeLightingPreset.optional(),
  key: z.number().min(0).optional(),
  fill: z.number().min(0).optional(),
  rim: z.number().min(0).optional(),
  ambient: z.number().min(0).optional(),
  exposure: z.number().min(0).optional(),
  warmth: z.number().min(0).max(100).optional(),
});

/** Either a named look preset, or explicit post-processing params. */
const SetLookParams = z.object({
  preset: BridgeLookPreset.optional(),
  bloom: z.number().min(0).max(2).optional(),
  contrast: z.number().min(-1).max(1).optional(),
  saturation: z.number().min(-1).max(1).optional(),
  vignette: z.number().min(0).max(1).optional(),
  grain: z.number().min(0).max(1).optional(),
});

const SetCaptureFormatParams = z.object({
  resolution: BridgeCaptureResolution,
  codec: BridgeCaptureCodec.optional(),
});

const AddCueParams = z.object({
  track: BridgeCueTrack,
  type: z.string().min(1),
  start: z.number().min(0),
  duration: z.number().min(0).optional(),
});

const UpdateCueParams = z.object({
  id: z.string().min(1),
  start: z.number().min(0).optional(),
  duration: z.number().min(0).optional(),
});

const RemoveCueParams = z.object({ id: z.string().min(1) });

const CaptureViewParams = z.object({ label: z.string().optional() });

const SetTimelineLengthParams = z.object({ seconds: z.number().min(0) });

const SetHeadlineParams = z.object({ text: z.string() });

/** Set a back-screen media url, or clear it. */
const SetBackscreenMediaParams = z.union([
  z.object({ url: z.string().min(1) }),
  z.object({ clear: z.literal(true) }),
]);

const ScreenshotParams = z.object({
  /**
   * What to capture. `output` renders an on-demand frame (works in a hidden/headless tab);
   * `viewport` reads the live preview canvas, whose rAF loop is PAUSED when the tab is hidden,
   * so it can be stale under automation. Optional — defaults to `output` for that reason.
   */
  target: BridgeScreenshotTarget.optional(),
  /** Optional timeline seek (seconds) before the shot. NOTE: this MOVES the playhead. */
  seek: z.number().min(0).optional(),
});

const ExecuteJsParams = z.object({ code: z.string() });

/** Commands that take no params. */
const EmptyParams = z.object({}).strict();

// ---------------------------------------------------------------------------
// Command discriminated union.
// ---------------------------------------------------------------------------

export const BridgeCommand = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('applyNewscast'), params: NewscastDocParams }),
  z.object({ cmd: z.literal('patchNewscast'), params: NewscastPatchParams }),
  z.object({ cmd: z.literal('validateNewscast'), params: NewscastDocParams }),
  z.object({ cmd: z.literal('setScript'), params: SetScriptParams }),
  z.object({ cmd: z.literal('setVoice'), params: SetVoiceParams }),
  z.object({ cmd: z.literal('setAvatar'), params: SetAvatarParams }),
  z.object({ cmd: z.literal('setEmotion'), params: SetEmotionParams }),
  z.object({ cmd: z.literal('setLighting'), params: SetLightingParams }),
  z.object({ cmd: z.literal('setLook'), params: SetLookParams }),
  z.object({ cmd: z.literal('setCaptureFormat'), params: SetCaptureFormatParams }),
  z.object({ cmd: z.literal('addCue'), params: AddCueParams }),
  z.object({ cmd: z.literal('updateCue'), params: UpdateCueParams }),
  z.object({ cmd: z.literal('removeCue'), params: RemoveCueParams }),
  z.object({ cmd: z.literal('listCues'), params: EmptyParams }),
  z.object({ cmd: z.literal('captureView'), params: CaptureViewParams }),
  z.object({ cmd: z.literal('setTimelineLength'), params: SetTimelineLengthParams }),
  z.object({ cmd: z.literal('clearTimeline'), params: EmptyParams }),
  z.object({ cmd: z.literal('setHeadline'), params: SetHeadlineParams }),
  z.object({ cmd: z.literal('setBackscreenMedia'), params: SetBackscreenMediaParams }),
  z.object({ cmd: z.literal('getState'), params: EmptyParams }),
  z.object({ cmd: z.literal('screenshot'), params: ScreenshotParams }),
  z.object({ cmd: z.literal('preview'), params: EmptyParams }),
  z.object({ cmd: z.literal('exportMp4'), params: EmptyParams }),
  z.object({ cmd: z.literal('executeJs'), params: ExecuteJsParams }),
]);
export type BridgeCommand = z.infer<typeof BridgeCommand>;

/** The `cmd` literal of any bridge command. */
export const BRIDGE_COMMANDS = [
  'applyNewscast',
  'patchNewscast',
  'validateNewscast',
  'setScript',
  'setVoice',
  'setAvatar',
  'setEmotion',
  'setLighting',
  'setLook',
  'setCaptureFormat',
  'addCue',
  'updateCue',
  'removeCue',
  'listCues',
  'captureView',
  'setTimelineLength',
  'clearTimeline',
  'setHeadline',
  'setBackscreenMedia',
  'getState',
  'screenshot',
  'preview',
  'exportMp4',
  'executeJs',
] as const;
export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number];

/**
 * The per-command params schema, keyed by command name. This is the SAME zod
 * object each branch of {@link BridgeCommand} carries — surfaced as a map so a
 * single source (the WebMCP tool manifest in `bridgeTools.ts`) can derive each
 * tool's JSON-Schema directly from the wire contract, with no second hand-kept
 * copy that could drift.
 */
export const BRIDGE_PARAM_SCHEMAS = {
  applyNewscast: NewscastDocParams,
  patchNewscast: NewscastPatchParams,
  validateNewscast: NewscastDocParams,
  setScript: SetScriptParams,
  setVoice: SetVoiceParams,
  setAvatar: SetAvatarParams,
  setEmotion: SetEmotionParams,
  setLighting: SetLightingParams,
  setLook: SetLookParams,
  setCaptureFormat: SetCaptureFormatParams,
  addCue: AddCueParams,
  updateCue: UpdateCueParams,
  removeCue: RemoveCueParams,
  listCues: EmptyParams,
  captureView: CaptureViewParams,
  setTimelineLength: SetTimelineLengthParams,
  clearTimeline: EmptyParams,
  setHeadline: SetHeadlineParams,
  setBackscreenMedia: SetBackscreenMediaParams,
  getState: EmptyParams,
  screenshot: ScreenshotParams,
  preview: EmptyParams,
  exportMp4: EmptyParams,
  executeJs: ExecuteJsParams,
} as const satisfies Record<BridgeCommandName, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Envelopes: request, result, register handshake.
// ---------------------------------------------------------------------------

/**
 * A request is a command tagged with a correlation `id`. The discriminated
 * union (`cmd` + `params`) is intersected with `{ id }` so the request stays a
 * single flat object on the wire.
 */
export const BridgeRequest = z.intersection(z.object({ id: z.string().min(1) }), BridgeCommand);
export type BridgeRequest = z.infer<typeof BridgeRequest>;

/** The reply envelope, correlated back to the request by `id`. */
export const BridgeResult = z.union([
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ id: z.string().min(1), ok: z.literal(false), error: z.string() }),
]);
export type BridgeResult = z.infer<typeof BridgeResult>;

/** Connect handshake sent by a studio when it joins the bridge. */
export const BridgeRegister = z.object({
  type: z.literal('register'),
  studioId: z.string().min(1),
  capabilities: z.array(z.string()).optional(),
});
export type BridgeRegister = z.infer<typeof BridgeRegister>;

// ---------------------------------------------------------------------------
// Validate helpers.
// ---------------------------------------------------------------------------

/** Parse + validate an untrusted bridge command (throws ZodError on invalid). */
export function parseBridgeCommand(input: unknown): BridgeCommand {
  return BridgeCommand.parse(input);
}

/** Parse + validate an untrusted bridge request (command + correlation id). */
export function parseBridgeRequest(input: unknown): BridgeRequest {
  return BridgeRequest.parse(input);
}

/** Parse + validate an untrusted bridge result envelope. */
export function parseBridgeResult(input: unknown): BridgeResult {
  return BridgeResult.parse(input);
}

/** Parse + validate an untrusted register handshake. */
export function parseBridgeRegister(input: unknown): BridgeRegister {
  return BridgeRegister.parse(input);
}

/** Build a success result envelope. */
export function bridgeOk(id: string, result?: unknown): BridgeResult {
  return { id, ok: true, result };
}

/** Build an error result envelope. */
export function bridgeError(id: string, error: string): BridgeResult {
  return { id, ok: false, error };
}
