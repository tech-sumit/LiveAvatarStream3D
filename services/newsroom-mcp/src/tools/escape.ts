/**
 * Newsroom MCP — escape hatch (task NM-5).
 *
 * `execute_js` runs an arbitrary snippet of JavaScript inside the studio page
 * (with `__las`, `app`, and `controllers` in scope) and returns the JSON result.
 * Last resort for things the typed tools don't cover yet.
 */

import { z } from 'zod';
import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

const executeJs = defineTool({
  name: 'execute_js',
  title: 'Execute JS in the studio',
  description:
    'Escape hatch: run arbitrary JavaScript inside the studio page. The snippet runs in an ' +
    'async function with `__las`, `app`, and `controllers` in scope; `return` a JSON-serializable ' +
    'value to get it back. Returns the JSON result as text.',
  inputSchema: {
    code: z.string().describe('JavaScript to run in the studio (may use return)'),
  },
  async handler({ code }) {
    const result = await callBridge('executeJs', { code });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const escapeTools: ToolDef<any>[] = [executeJs];
