/**
 * Newsroom MCP — feedback tools (task NM-5).
 *
 * Read the studio back: a full state snapshot, and a screenshot of either the
 * editor viewport or the render output. The screenshot tool reads the PNG the
 * studio POSTed to the upload sink and returns it as an MCP image content block
 * so the client can see the frame inline.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, type ToolDef, type ToolResult } from '../server.js';
import { callBridge, uploadedPath } from '../transport.js';

const getStudioState = defineTool({
  name: 'get_studio_state',
  title: 'Get the studio state',
  description:
    'Fetch a full snapshot of the studio: script, voice, avatar, emotion, lighting, look, ' +
    'capture format, cues, timeline length, headline, busy/idle, and the avatar/voice catalogs. ' +
    'Returned as JSON text.',
  inputSchema: {},
  async handler() {
    const state = await callBridge('getState', {});
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  },
});

const screenshot = defineTool({
  name: 'screenshot',
  title: 'Capture a studio screenshot',
  description:
    'Capture a PNG of the studio. `target` is "output" (the render output frame, default) or ' +
    '"viewport" (the editor canvas). `seek` (optional, seconds) seeks the timeline before the shot. ' +
    'Returns the image inline.',
  inputSchema: {
    target: z
      .enum(['viewport', 'output'])
      .optional()
      .describe('What to capture: "output" (default) or "viewport"'),
    seek: z.number().min(0).optional().describe('Timeline seek (seconds) before the shot'),
  },
  async handler({ target, seek }): Promise<ToolResult> {
    const t = target ?? 'output';
    const r = (await callBridge('screenshot', { target: t, seek })) as {
      ref: string;
      bytes: number;
      width?: number;
      height?: number;
    };
    const path = uploadedPath(r.ref);
    if (!path) {
      return {
        content: [{ type: 'text', text: `Screenshot captured (ref ${r.ref}) but no uploaded file was found.` }],
        isError: true,
      };
    }
    const data = (await readFile(path)).toString('base64');
    const dims = r.width != null && r.height != null ? ` (${r.width}x${r.height})` : '';
    // ToolResult types `content` as text-only, but the MCP SDK accepts image
    // content blocks too. Build the mixed array and widen it at this boundary.
    const content = [
      { type: 'text', text: `Screenshot of ${t}${dims}, ${r.bytes} bytes.` },
      { type: 'image', data, mimeType: 'image/png' },
    ] as unknown as ToolResult['content'];
    return { content };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const feedbackTools: ToolDef<any>[] = [getStudioState, screenshot];
