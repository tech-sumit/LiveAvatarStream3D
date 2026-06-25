/**
 * Live end-to-end demo: a real MCP CLIENT spawns the newsroom-mcp server over stdio
 * and authors a whole newscast purely through tool calls — the studio is configured,
 * the back-wall graphics are generated + loaded, music is synthesized, and a frame is
 * captured. Open http://localhost:5175/?bridge=9777 when prompted.
 *
 * Run: node dist/scripts/demo-client.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'server.js'); // dist/server.js
const log = (m: string) => process.stderr.write(`\n\x1b[36m${m}\x1b[0m\n`);

function textOf(r: any): string {
  return (r?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}
function imageOf(r: any): { data: string; mime: string } | null {
  const img = (r?.content ?? []).find((c: any) => c.type === 'image');
  return img ? { data: img.data, mime: img.mimeType } : null;
}

const DOC = {
  version: 2,
  meta: { title: 'Newsroom MCP — live demo', anchors: [{ id: 'a', name: 'Ava Lin', avatarUrl: 'avaturn-model', voiceId: 'EXAVITQu4vr4xnSDxMaL' }], fps: 30, aspect: '16:9' },
  look: { preset: 'broadcast' },
  defaults: { emotion: 'neutral', idleMotion: true, headline: 'LIVE: AI-DRIVEN NEWSROOM' },
  rundown: [
    { id: 'o', slug: 'open', storyForm: 'READER', headline: 'BREAKING', beats: [
      { id: 'o1', text: 'Good evening. Everything you are watching was produced by an A.I. calling tools.', emotion: 'warm', gesture: 'open_palms', camera: { shot: 'medium' } },
      { id: 'o2', text: 'The script, camera, lighting, and the graphics behind me — all set through one interface.', emotion: 'confident', gesture: 'point', camera: { shot: 'wide' } },
    ] },
    { id: 'k', slug: 'kicker', storyForm: 'KICKER', headline: 'DEVELOPING', beats: [
      { id: 'k1', text: 'This is the newsroom, fully automated. Good night.', emotion: 'happy', gesture: 'wave', camera: { shot: 'close_up' } },
    ] },
  ],
};

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
  const client = new Client({ name: 'newsroom-demo-client', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  log(`[demo] connected to newsroom-mcp · ${tools.length} tools available`);
  const call = async (name: string, args: Record<string, unknown> = {}, timeoutMs = 240_000) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    if ((r as any).isError) log(`[demo] ✗ ${name}: ${textOf(r)}`);
    return r as any;
  };

  log('[demo] → connect_studio(attended). OPEN http://localhost:5175/?bridge=9777 in your browser NOW…');
  log(textOf(await call('connect_studio', { mode: 'attended' })));

  log('[demo] → set_newscast (LLM-authored report)');
  log(textOf(await call('set_newscast', { doc: DOC })));

  // wait until the studio finishes loading the avatar/voices
  for (let i = 0; i < 40; i++) {
    const s = JSON.parse(textOf(await call('get_studio_state')) || '{}');
    if (s.avatar && !s.busy) { log(`[demo] studio ready · avatar=${s.avatar} cues=${s.cues?.length}`); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('[demo] → generate_backscreen_cards (broadcast graphics from facts)');
  const cardsRes = await call('generate_backscreen_cards', {
    headline: 'AI-DRIVEN NEWSROOM', what: 'Produced entirely through MCP tools',
    why: 'One LLM, one interface, full control of the studio',
    numbers: '33 tools across 3 tiers', quote: 'The newsroom is fully automated.',
  });
  const urls: string[] = JSON.parse(textOf(cardsRes) || '{}').urls ?? [];
  log(`[demo]   ${urls.length} cards generated`);

  log('[demo] → build_backscreen_montage (cards → wall video, loaded live on the studio wall)');
  log(textOf(await call('build_backscreen_montage', { cards: urls })));

  log('[demo] → generate_music (synthesized news score)');
  log(textOf(await call('generate_music', { mood: 'breaking' })));

  // Frame a medium shot (reveals the wall), settle the avatar to idle, and cue the
  // montage — all via the execute_js escape hatch.
  log('[demo] → execute_js (frame medium + idle + cue wall) [escape hatch]');
  log(textOf(await call('execute_js', {
    code: "const av=window.__las.avatar; if(av.restToIdle)av.restToIdle(); const s=document.getElementById('shot'); if(s){s.value='medium'; s.dispatchEvent(new Event('change'));} if(window.__las.wallVideo){try{window.__las.wallVideo.currentTime=4;}catch(e){}} return 'framed medium + idle + wall@4s';",
  })));
  await new Promise((r) => setTimeout(r, 2500));
  log('[demo] → screenshot (the LLM-authored studio: anchor + generated wall + broadcast look)');
  const shot = await call('screenshot', { target: 'output' });
  const img = imageOf(shot);
  if (img) {
    const out = '/tmp/newsroom-mcp-demo.png';
    writeFileSync(out, Buffer.from(img.data, 'base64'));
    log(`[demo] ✓ screenshot saved → ${out}`);
  } else {
    log(`[demo] screenshot: ${textOf(shot)}`);
  }

  log('[demo] → export_mp4 (Tier-1 in-browser WebCodecs render → file) [best-effort]');
  try {
    log(textOf(await call('export_mp4', {}, 300_000)));
  } catch (e) {
    log(`[demo] export skipped (Tier-1 export needs a foreground/GPU browser): ${String(e)}`);
  }

  log('[demo] ✅ DONE — a full newscast authored end-to-end through MCP tools.');
  await client.close();
  process.exit(0);
}
main().catch((e) => { log(`[demo] FAIL: ${String(e)}`); process.exit(1); });
