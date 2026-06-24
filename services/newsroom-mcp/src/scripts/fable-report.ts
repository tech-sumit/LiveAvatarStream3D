/**
 * Produce the Anthropic "Fable 5 / Mythos 5 suspension" newscast entirely through the
 * Newsroom MCP tools: author the report, generate the wall graphics + music, capture a
 * frame, export the MP4, and post-produce an intro + music bed. Open
 * http://localhost:5175/?bridge=9777 when prompted (and click the tab once to unlock audio).
 *
 * Run: node dist/scripts/fable-report.js   → final MP4 path printed at the end.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'server.js');
const log = (m: string) => process.stderr.write(`\n\x1b[36m${m}\x1b[0m\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any) => (r?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const imageOf = (r: any) => { const i = (r?.content ?? []).find((c: any) => c.type === 'image'); return i ? { data: i.data } : null; };
const json = (r: any) => { try { return JSON.parse(textOf(r)); } catch { return {}; } };

const DOC = {
  version: 2,
  meta: { title: 'Anthropic suspends Fable 5 & Mythos 5', anchors: [{ id: 'a', name: 'Ava Lin', avatarUrl: 'avaturn-model', voiceId: 'EXAVITQu4vr4xnSDxMaL' }], fps: 30, aspect: '16:9' },
  look: { preset: 'broadcast' },
  defaults: { emotion: 'neutral', idleMotion: true, headline: 'BREAKING: AI MODELS SUSPENDED' },
  rundown: [
    { id: 'open', slug: 'o', storyForm: 'READER', headline: 'BREAKING TONIGHT', beats: [
      { id: 'o1', text: 'Good evening, and welcome to the broadcast.', emotion: 'warm', gesture: 'open_palms', camera: { shot: 'medium' } },
      { id: 'o2', text: 'Our top story: Anthropic has suspended two of its flagship A.I. models.', emotion: 'serious', gesture: 'none' } ] },
    { id: 'story', slug: 's', storyForm: 'VO', headline: 'FABLE 5 AND MYTHOS 5 PULLED', beats: [
      { id: 's1', text: 'The company says it disabled Fable five and Mythos five for every customer.', emotion: 'serious', gesture: 'point', camera: { shot: 'wide' } },
      { id: 's2', text: 'The move follows a United States government directive that cited national security.', emotion: 'concerned', gesture: 'hand_to_chest' } ] },
    { id: 'detail', slug: 'd', storyForm: 'VO', headline: 'A NARROW JAILBREAK', beats: [
      { id: 'd1', text: 'According to the company, the directive points to a narrow jailbreak.', emotion: 'thoughtful', gesture: 'explain', camera: { shot: 'medium' } },
      { id: 'd2', text: 'Anthropic notes that other A.I. models already share that same capability.', emotion: 'confident', gesture: 'none' } ] },
    { id: 'sign', slug: 'k', storyForm: 'KICKER', headline: 'DEVELOPING STORY', beats: [
      { id: 'k1', text: 'We will keep following this developing story as it unfolds.', emotion: 'warm', gesture: 'nod', camera: { shot: 'medium' } },
      { id: 'k2', text: 'For now, that is the latest from the newsroom. Good night.', emotion: 'happy', gesture: 'wave', camera: { shot: 'close_up' } } ] },
  ],
};

async function main() {
  const client = new Client({ name: 'fable-report-client', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry] }));
  const { tools } = await client.listTools();
  log(`[fable] connected · ${tools.length} MCP tools`);
  const call = async (name: string, args: Record<string, unknown> = {}, t = 300_000) => {
    const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: t });
    if (r.isError) log(`[fable] ✗ ${name}: ${textOf(r)}`);
    return r;
  };

  log('[fable] → connect_studio(attended). OPEN http://localhost:5175/?bridge=9777 + click the tab once.');
  log(textOf(await call('connect_studio', { mode: 'attended' })));

  log('[fable] → set_newscast (the Fable/Mythos report)');
  log(textOf(await call('set_newscast', { doc: DOC })));
  for (let i = 0; i < 40; i++) { const s = json(await call('get_studio_state')); if (s.avatar && !s.busy) { log(`[fable] ready · avatar=${s.avatar} cues=${s.cues?.length}`); break; } await sleep(1000); }

  log('[fable] → generate_backscreen_cards (story facts → broadcast graphics)');
  const cards = json(await call('generate_backscreen_cards', {
    headline: 'AI MODELS SUSPENDED', what: 'Fable 5 and Mythos 5 — access suspended for all customers',
    why: 'A U.S. government directive citing national security',
    numbers: 'Hundreds of millions of users · thousands of hours of testing', quote: 'We found no universal jailbreak.',
  }));
  const cardUrls: string[] = cards.urls ?? [];
  const titleCard: string | undefined = cards.cards?.[0]?.path;
  log(`[fable]   ${cardUrls.length} cards`);

  log('[fable] → build_backscreen_montage (→ live on the wall)');
  log(textOf(await call('build_backscreen_montage', { cards: cardUrls })));

  log('[fable] → generate_music (breaking)');
  const music = json(await call('generate_music', { mood: 'breaking' }));
  const musicWav: string | undefined = music.path;

  await call('execute_js', { code: "const av=window.__las.avatar; if(av.restToIdle)av.restToIdle(); const s=document.getElementById('shot'); if(s){s.value='medium'; s.dispatchEvent(new Event('change'));} if(window.__las.wallVideo){try{window.__las.wallVideo.currentTime=4;}catch(e){}} return 'framed';" });
  await sleep(2000);
  const shot = await call('screenshot', { target: 'output' });
  const img = imageOf(shot);
  if (img) { writeFileSync('/tmp/fable-mcp-shot.png', Buffer.from(img.data, 'base64')); log('[fable] ✓ screenshot → /tmp/fable-mcp-shot.png'); }

  log('[fable] → export_mp4 (rendering… keep the studio tab foreground)');
  const exText = textOf(await call('export_mp4', {}, 300_000));
  log(`[fable]   ${exText}`);
  const exPath = (exText.match(/(\/\S+\.mp4)/) || [])[1];

  if (exPath) {
    log('[fable] → post_produce (intro card + music bed)');
    const post = json(await call('post_produce', { inputMp4: exPath, introCard: titleCard, musicWav, introSeconds: 3.5 }));
    log(`[fable] ✓ FINAL → ${post.path || post.url || JSON.stringify(post)}`);
    if (post.path) writeFileSync('/tmp/fable-report-FINAL.txt', post.path);
  } else {
    log('[fable] export did not produce a file — see above.');
  }

  log('[fable] ✅ DONE — Fable/Mythos report produced through the Newsroom MCP.');
  await client.close();
  process.exit(0);
}
main().catch((e) => { log(`[fable] FAIL: ${String(e)}`); process.exit(1); });
