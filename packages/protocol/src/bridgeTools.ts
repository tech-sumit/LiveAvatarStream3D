import { zodToJsonSchema } from 'zod-to-json-schema';
import { BRIDGE_COMMANDS, BRIDGE_PARAM_SCHEMAS, type BridgeCommandName } from './bridge.js';

/**
 * The WebMCP tool manifest for the avatar-live studio.
 *
 * This is the SINGLE definition of the studio's MCP tool surface (the §4 table of
 * `docs/specs/2026-06-25-webmcp-studio-control-design.md`). It is derived 1:1 from the
 * existing bridge contract ({@link BRIDGE_COMMANDS} + {@link BRIDGE_PARAM_SCHEMAS}), so the
 * MCP tool vocabulary cannot drift from the bridge command vocabulary — every command is
 * exposed exactly once, and each tool's `inputSchema` is generated straight from that
 * command's zod params. The in-page `StudioMcpServer` (`apps/avatar-live/src/mcp/`) is a thin
 * adapter that registers these with `navigator.modelContext` and routes each `execute` back
 * through the same bridge dispatcher.
 */
export interface BridgeToolDef {
  /** snake_case MCP tool name (e.g. `set_script`), derived from the camelCase command. */
  readonly name: string;
  /** The bridge command this tool invokes. */
  readonly cmd: BridgeCommandName;
  /** Agent-facing description. */
  readonly description: string;
  /** True for tools that only read studio state (`readOnlyHint`). */
  readonly readOnly: boolean;
  /** JSON Schema for the tool input, generated from the command's zod params. */
  readonly inputSchema: Record<string, unknown>;
}

/** camelCase command → snake_case tool name (`applyNewscast` → `apply_newscast`,
 *  `exportMp4` → `export_mp4`): underscore before each capital, digits stay attached. */
function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Per-command agent-facing description + read-only classification. */
const TOOL_META: Record<BridgeCommandName, { description: string; readOnly?: true }> = {
  applyNewscast: {
    description:
      'Load a full performance into the studio. `doc` is a Score (preferred) or a legacy NewsReportDoc; it is validated, compiled, and made previewable/exportable.',
  },
  patchNewscast: {
    description: 'Shallow-merge a patch over the last-applied newscast doc and re-import it.',
  },
  validateNewscast: {
    description: 'Validate a Score or NewsReportDoc without applying it. Returns {valid, kind} or {valid:false, error}.',
    readOnly: true,
  },
  setScript: { description: "Set the spoken script (one sentence per line; inline [emotion][gesture] tags supported)." },
  setVoice: { description: 'Select the TTS voice by id, optionally with rate and pitch.' },
  setAvatar: { description: 'Load an avatar by catalog id or by glTF URL.' },
  setEmotion: { description: 'Set the default facial emotion preset.' },
  setLighting: { description: 'Set the studio lighting: a named preset and/or explicit per-channel levels.' },
  setLook: { description: 'Set the cinematic post-processing look: a named preset and/or explicit params (bloom, contrast, …).' },
  setCaptureFormat: { description: 'Set the export resolution preset and optional codec (avc/hevc).' },
  addCue: { description: 'Add a timeline cue on a track (camera/gesture/emotion/audio/event). Returns the new cue id.' },
  updateCue: { description: 'Update an existing cue’s start and/or duration.' },
  removeCue: { description: 'Remove a timeline cue by id.' },
  listCues: { description: 'List all timeline cues.', readOnly: true },
  captureView: { description: 'Save the current camera as a reusable shot. Returns the saved shot id.' },
  setTimelineLength: { description: 'Set the timeline length in seconds.' },
  clearTimeline: { description: 'Remove all timeline cues.' },
  setHeadline: { description: 'Set the lower-third headline text.' },
  setBackscreenMedia: { description: 'Set the video-wall media by url, or clear it ({clear:true}).' },
  getState: {
    description: 'Snapshot the current studio state: script, voice, avatar, lighting, look, cues, catalogs, and busy/idle.',
    readOnly: true,
  },
  screenshot: {
    description:
      'Render a screenshot of the studio (the see→verify primitive). `target` defaults to `output` (an on-demand frame that also works in a hidden/headless tab); `viewport` reads the live preview canvas, which is paused when the tab is hidden. Over WebMCP the image is returned as a downscaled JPEG thumbnail (not full-res). NOT read-only: `seek` moves the timeline playhead.',
  },
  preview: { description: 'Start live preview playback in the studio.' },
  exportMp4: { description: 'Render the performance to an MP4 in-browser and download it. Returns {bytes, filename}.' },
  executeJs: {
    description: 'Escape hatch: run arbitrary JS in the studio page against (__las, app, controllers). Only registered when explicitly enabled.',
  },
};

/**
 * Strip the `$schema` key zod-to-json-schema adds, and flatten a top-level `anyOf` of object
 * branches (a zod `z.union(...)` of objects, e.g. setBackscreenMedia's url-or-clear) into a
 * single `type: "object"` schema. WebMCP/MCP expect a tool `inputSchema` to be a JSON-Schema
 * OBJECT — a bare `{ anyOf: [...] }` is rejected or unrendered by strict clients. The union is
 * still enforced strictly at call time by the zod schema (see {@link BRIDGE_PARAM_SCHEMAS} +
 * the WebMCP adapter's validation), so widening the advertised shape loses no safety.
 */
function toInputSchema(cmd: BridgeCommandName): Record<string, unknown> {
  const raw = zodToJsonSchema(BRIDGE_PARAM_SCHEMAS[cmd], { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<
    string,
    unknown
  >;
  const { $schema, ...rest } = raw;
  const anyOf = rest.anyOf as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(anyOf) && anyOf.every((b) => b?.type === 'object')) {
    // Merge each branch's properties; no key is required (a property is only present in some
    // branches), so drop `required`. additionalProperties:false matches the strict zod objects.
    const properties: Record<string, unknown> = {};
    for (const branch of anyOf) {
      Object.assign(properties, (branch.properties as Record<string, unknown>) ?? {});
    }
    return { type: 'object', properties, additionalProperties: false };
  }
  return rest;
}

/** The studio's MCP tool surface — one entry per bridge command, in command order. */
export const BRIDGE_TOOLS: readonly BridgeToolDef[] = BRIDGE_COMMANDS.map((cmd) => ({
  name: camelToSnake(cmd),
  cmd,
  description: TOOL_META[cmd].description,
  readOnly: TOOL_META[cmd].readOnly === true,
  inputSchema: toInputSchema(cmd),
}));
