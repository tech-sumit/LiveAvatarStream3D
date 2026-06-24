/**
 * Newsroom MCP — render tools (task NM-5).
 *
 * Drive the studio's playback / export: start a timeline preview, and export the
 * performance to an mp4. The export reads back the file the studio POSTed to the
 * upload sink and returns the saved local .mp4 path (plus its size).
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { callBridge, uploadedPath } from '../transport.js';

function asText(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

const preview = defineTool({
  name: 'preview',
  title: 'Start a timeline preview',
  description: 'Start playing the timeline preview in the studio.',
  inputSchema: {},
  async handler() {
    return asText(await callBridge('preview', {}));
  },
});

const exportMp4 = defineTool({
  name: 'export_mp4',
  title: 'Export the performance to mp4',
  description:
    'Render and export the current performance to an mp4. Returns the saved local .mp4 path ' +
    'and its size in bytes.',
  inputSchema: {},
  async handler() {
    // The offline render (TTS mixdown + per-frame WebCodecs encode) routinely exceeds the
    // default bridge timeout, so give it a generous window.
    const r = (await callBridge('exportMp4', {}, { timeoutMs: 280_000 })) as { ref: string; bytes: number };
    const path = uploadedPath(r.ref);
    if (!path) {
      return {
        content: [{ type: 'text' as const, text: `Export produced ref ${r.ref} but no uploaded file was found.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: `Exported mp4 (${r.bytes} bytes): ${path}` }],
    };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const renderTools: ToolDef<any>[] = [preview, exportMp4];
