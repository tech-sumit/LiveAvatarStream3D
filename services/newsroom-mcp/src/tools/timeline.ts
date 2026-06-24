/**
 * Newsroom MCP — timeline tools (task NM-5).
 *
 * Thin {@link callBridge} wrappers over the studio's timeline editor: add /
 * update / remove / list cues, capture the live viewport as a camera cue, set
 * the overall timeline length, and clear it. Each tool forwards its args to the
 * matching {@link BridgeCommandName} and returns the studio's JSON result as
 * text.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

function asText(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

const addCue = defineTool({
  name: 'add_cue',
  title: 'Add a timeline cue',
  description:
    'Add a cue to a timeline track. `track` is one of camera/gesture/emotion/audio/event, ' +
    '`type` is the cue type, `start` is its start time in seconds, and `duration` (optional) ' +
    'is its length in seconds. Returns the new cue id.',
  inputSchema: {
    track: z.enum(['camera', 'gesture', 'emotion', 'audio', 'event']).describe('Timeline track to add the cue to'),
    type: z.string().min(1).describe('Cue type'),
    start: z.number().min(0).describe('Cue start time (seconds)'),
    duration: z.number().min(0).optional().describe('Cue duration (seconds)'),
  },
  async handler({ track, type, start, duration }) {
    return asText(await callBridge('addCue', { track, type, start, duration }));
  },
});

const updateCue = defineTool({
  name: 'update_cue',
  title: 'Update a timeline cue',
  description: 'Move or resize an existing cue by id. Provide `start` and/or `duration` (seconds).',
  inputSchema: {
    id: z.string().min(1).describe('Cue id'),
    start: z.number().min(0).optional().describe('New start time (seconds)'),
    duration: z.number().min(0).optional().describe('New duration (seconds)'),
  },
  async handler({ id, start, duration }) {
    return asText(await callBridge('updateCue', { id, start, duration }));
  },
});

const removeCue = defineTool({
  name: 'remove_cue',
  title: 'Remove a timeline cue',
  description: 'Remove a cue from the timeline by id.',
  inputSchema: {
    id: z.string().min(1).describe('Cue id'),
  },
  async handler({ id }) {
    return asText(await callBridge('removeCue', { id }));
  },
});

const listCues = defineTool({
  name: 'list_cues',
  title: 'List timeline cues',
  description: 'List all cues currently on the timeline.',
  inputSchema: {},
  async handler() {
    return asText(await callBridge('listCues', {}));
  },
});

const captureView = defineTool({
  name: 'capture_view',
  title: 'Capture the current viewport as a camera cue',
  description:
    'Snapshot the live viewport camera into a new camera cue on the timeline. ' +
    'An optional `label` names the captured view. Returns the new cue id.',
  inputSchema: {
    label: z.string().optional().describe('Optional label for the captured view'),
  },
  async handler({ label }) {
    return asText(await callBridge('captureView', { label }));
  },
});

const setTimelineLength = defineTool({
  name: 'set_timeline_length',
  title: 'Set the timeline length',
  description: 'Set the overall timeline duration in seconds.',
  inputSchema: {
    seconds: z.number().min(0).describe('Timeline length (seconds)'),
  },
  async handler({ seconds }) {
    return asText(await callBridge('setTimelineLength', { seconds }));
  },
});

const clearTimeline = defineTool({
  name: 'clear_timeline',
  title: 'Clear the timeline',
  description: 'Remove every cue from the timeline.',
  inputSchema: {},
  async handler() {
    return asText(await callBridge('clearTimeline', {}));
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const timelineTools: ToolDef<any>[] = [
  addCue,
  updateCue,
  removeCue,
  listCues,
  captureView,
  setTimelineLength,
  clearTimeline,
];
