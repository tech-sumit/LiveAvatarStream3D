/**
 * Newsroom MCP — back-screen tools (task NM-5).
 *
 * Drive the studio's back-wall screen: set the lower-third headline text, and
 * set (or clear) the back-screen media video. Thin {@link callBridge} wrappers.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

function asText(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

const setHeadline = defineTool({
  name: 'set_headline',
  title: 'Set the back-screen headline',
  description: 'Set the studio back-screen / lower-third headline text.',
  inputSchema: {
    text: z.string().describe('Headline text'),
  },
  async handler({ text }) {
    return asText(await callBridge('setHeadline', { text }));
  },
});

const setBackscreenMedia = defineTool({
  name: 'set_backscreen_media',
  title: 'Set or clear the back-screen media',
  description:
    'Set the back-wall screen video by `url`, or pass `clear: true` to revert the screen ' +
    'to its default. Provide exactly one of the two.',
  inputSchema: {
    url: z.string().min(1).optional().describe('Video URL to show on the back screen'),
    clear: z.literal(true).optional().describe('Set true to clear the back-screen media'),
  },
  async handler({ url, clear }) {
    const params = clear ? { clear: true as const } : { url: String(url) };
    return asText(await callBridge('setBackscreenMedia', params));
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const backscreenTools: ToolDef<any>[] = [setHeadline, setBackscreenMedia];
