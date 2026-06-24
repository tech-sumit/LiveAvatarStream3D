/**
 * Newsroom MCP — performance mutator tools (task NM-4).
 *
 * Thin wrappers over the studio's scalar setters: script, voice, avatar,
 * emotion, lighting, look, and capture format. Each tool's `inputSchema`
 * mirrors the matching command's params in `@las/protocol`'s `bridge.ts`,
 * reusing protocol vocabularies ({@link Emotion} and the bridge lighting/look/
 * resolution/codec literals) so the vocabulary cannot drift. Each handler
 * forwards its parsed args straight to {@link callBridge} and returns a short
 * confirmation.
 *
 * These plug into the registry via the `performTools` export, which the
 * orchestrator spreads into `TOOL_MODULES` in `server.ts` (do not edit
 * `server.ts` here).
 */

import { z } from 'zod';
import {
  Emotion,
  BridgeLightingPreset,
  BridgeLookPreset,
  BridgeCaptureResolution,
  BridgeCaptureCodec,
} from '@las/protocol';

import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

const setScript = defineTool({
  name: 'set_script',
  title: 'Set the performance script',
  description: 'Set the script line the avatar will speak.',
  inputSchema: {
    script: z.string().describe('The script text for the avatar to perform.'),
  },
  async handler({ script }) {
    await callBridge('setScript', { script });
    return { content: [{ type: 'text', text: `Script set (${script.length} chars).` }] };
  },
});

const setVoice = defineTool({
  name: 'set_voice',
  title: 'Set the voice',
  description: 'Select the voice and optionally adjust its rate and pitch.',
  inputSchema: {
    voiceId: z.string().min(1).describe('The voice id to select.'),
    rate: z.number().min(0.5).max(2).optional().describe('Speaking rate multiplier (0.5–2).'),
    pitch: z.number().min(0.5).max(2).optional().describe('Pitch multiplier (0.5–2).'),
  },
  async handler({ voiceId, rate, pitch }) {
    await callBridge('setVoice', { voiceId, rate, pitch });
    const extra = [
      rate != null ? `rate ${rate}` : null,
      pitch != null ? `pitch ${pitch}` : null,
    ].filter(Boolean);
    return {
      content: [
        {
          type: 'text',
          text: `Voice set to "${voiceId}"${extra.length ? ` (${extra.join(', ')})` : ''}.`,
        },
      ],
    };
  },
});

const setAvatar = defineTool({
  name: 'set_avatar',
  title: 'Set the avatar',
  description: 'Load an avatar by folder id or by http(s) URL.',
  inputSchema: {
    avatar: z.string().min(1).describe('An avatar folder id (e.g. "avaturn-model") or an http(s) URL.'),
  },
  async handler({ avatar }) {
    await callBridge('setAvatar', { avatar });
    return { content: [{ type: 'text', text: `Avatar set to "${avatar}".` }] };
  },
});

const setEmotion = defineTool({
  name: 'set_emotion',
  title: 'Set the emotion',
  description: 'Set the avatar\'s current emotion.',
  inputSchema: {
    emotion: Emotion.describe('The emotion to apply (from the protocol Emotion vocabulary).'),
  },
  async handler({ emotion }) {
    await callBridge('setEmotion', { emotion });
    return { content: [{ type: 'text', text: `Emotion set to "${emotion}".` }] };
  },
});

const setLighting = defineTool({
  name: 'set_lighting',
  title: 'Set the lighting',
  description:
    'Apply a lighting preset and/or nudge individual channels. Any subset of ' +
    'fields may be given; the studio fills the rest.',
  inputSchema: {
    preset: BridgeLightingPreset.optional().describe('Named lighting preset.'),
    key: z.number().min(0).optional().describe('Key light intensity.'),
    fill: z.number().min(0).optional().describe('Fill light intensity.'),
    rim: z.number().min(0).optional().describe('Rim light intensity.'),
    ambient: z.number().min(0).optional().describe('Ambient light intensity.'),
    exposure: z.number().min(0).optional().describe('Exposure.'),
    warmth: z.number().min(0).max(100).optional().describe('Color warmth (0–100).'),
  },
  async handler(params) {
    await callBridge('setLighting', params);
    return { content: [{ type: 'text', text: describeChange('Lighting', params) }] };
  },
});

const setLook = defineTool({
  name: 'set_look',
  title: 'Set the cinematic look',
  description:
    'Apply a cinematic "look" preset and/or override individual post-processing ' +
    'parameters. Any subset of fields may be given.',
  inputSchema: {
    preset: BridgeLookPreset.optional().describe('Named look preset.'),
    bloom: z.number().min(0).max(2).optional().describe('Bloom strength (0–2).'),
    contrast: z.number().min(-1).max(1).optional().describe('Contrast (-1–1).'),
    saturation: z.number().min(-1).max(1).optional().describe('Saturation (-1–1).'),
    vignette: z.number().min(0).max(1).optional().describe('Vignette amount (0–1).'),
    grain: z.number().min(0).max(1).optional().describe('Film grain amount (0–1).'),
  },
  async handler(params) {
    await callBridge('setLook', params);
    return { content: [{ type: 'text', text: describeChange('Look', params) }] };
  },
});

const setCaptureFormat = defineTool({
  name: 'set_capture_format',
  title: 'Set the capture format',
  description: 'Set the export resolution and optionally the video codec.',
  inputSchema: {
    resolution: BridgeCaptureResolution.describe('Capture resolution preset.'),
    codec: BridgeCaptureCodec.optional().describe('Export video codec (avc or hevc).'),
  },
  async handler({ resolution, codec }) {
    await callBridge('setCaptureFormat', { resolution, codec });
    return {
      content: [
        {
          type: 'text',
          text: `Capture format set to ${resolution}${codec ? ` (${codec})` : ''}.`,
        },
      ],
    };
  },
});

/** Render a "<Subject> updated: k=v, ..." confirmation from a sparse params object. */
function describeChange(subject: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `${subject} updated: ${parts.join(', ')}.` : `${subject} unchanged (no fields given).`;
}

/** The performance tool module — spread into `TOOL_MODULES` by the orchestrator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const performTools: ToolDef<any>[] = [
  setScript,
  setVoice,
  setAvatar,
  setEmotion,
  setLighting,
  setLook,
  setCaptureFormat,
];
