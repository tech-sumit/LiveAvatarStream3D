/**
 * Newsroom MCP — smoke test.
 *
 * Spawns the built server (dist/server.js) over stdio with a real MCP client,
 * lists its tools and resources, and PASSes only if the tool surface is exactly
 * the asset-generation set (no studio-control tools — those live in the
 * studio's in-browser WebMCP server now) and the generated-assets resource is
 * present and readable.
 *
 * Run: `npm run build --workspace @las/newsroom-mcp && npm run smoke --workspace @las/newsroom-mcp`
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'server.js'); // dist/server.js

/** The complete expected tool surface: asset generation only. */
const EXPECTED_TOOLS = [
  'build_backscreen_montage',
  'generate_audio',
  'generate_backscreen_cards',
  'generate_graphics',
  'generate_image',
  'generate_music',
  'post_produce',
].sort();

const EXPECTED_RESOURCES = ['newsroom://assets/generated'];

async function main(): Promise<void> {
  const client = new Client({ name: 'newsroom-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
  await client.connect(transport);

  const failures: string[] = [];
  try {
    // 1) The tool list must be exactly the asset tools.
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
      const extra = tools.filter((t) => !EXPECTED_TOOLS.includes(t));
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
      failures.push(
        `tool surface mismatch — extra: [${extra.join(', ')}] missing: [${missing.join(', ')}]`,
      );
    }

    // 2) The generated-assets resource must exist and be readable JSON.
    const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
    for (const uri of EXPECTED_RESOURCES) {
      if (!resources.includes(uri)) {
        failures.push(`missing resource ${uri} (got: ${resources.join(', ') || 'none'})`);
        continue;
      }
      const read = await client.readResource({ uri });
      const text = read.contents[0] && 'text' in read.contents[0] ? read.contents[0].text : '';
      const parsed = JSON.parse(String(text)) as { workDir?: string; assets?: unknown[] };
      if (!parsed.workDir || !Array.isArray(parsed.assets)) {
        failures.push(`${uri} returned unexpected payload: ${String(text).slice(0, 200)}`);
      }
    }
  } finally {
    await client.close();
  }

  if (failures.length) {
    process.stderr.write(`SMOKE FAIL:\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `SMOKE PASS: ${EXPECTED_TOOLS.length} asset tools, ${EXPECTED_RESOURCES.length} resource(s).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`SMOKE FAIL: ${String(err)}\n`);
  process.exit(1);
});
