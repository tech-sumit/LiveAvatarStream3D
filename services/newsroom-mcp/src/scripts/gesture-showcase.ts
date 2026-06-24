/**
 * Gesture showcase reel — a short newscast where the anchor fires each (good) gesture
 * in turn, to show the real Mixamo-retargeted motion in context. Produced entirely
 * through the Newsroom MCP. Open http://localhost:5175/?bridge=9777 + click the tab once.
 *
 * Run: node dist/scripts/gesture-showcase.js
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
const json = (r: any) => { try { return JSON.parse(textOf(r)); } catch { return {}; } };

const DOC = {
  version: 2,
  meta: { title: 'Gesture Showcase', anchors: [{ id: 'a', name: 'Ava Lin', avatarUrl: 'avaturn-model', voiceId: 'EXAVITQu4vr4xnSDxMaL' }], fps: 30, aspect: '16:9' },
  look: { preset: 'broadcast' },
  defaults: { emotion: 'neutral', idleMotion: true, headline: 'LIVE FROM THE NEWSROOM' },
  rundown: [
    { id: 'open', slug: 'o', storyForm: 'READER', headline: 'GOOD EVENING', beats: [
      { id: 'o1', text: 'Good evening, and welcome to the broadcast.', emotion: 'warm', gesture: 'wave', camera: { shot: 'medium' } },
      { id: 'o2', text: 'Our top story tonight is right here, behind me.', emotion: 'confident', gesture: 'point', camera: { shot: 'wide' } } ] },
    { id: 'body', slug: 'b', storyForm: 'VO', headline: 'THE FULL PICTURE', beats: [
      { id: 'b1', text: 'There is so much that we want to share with you today.', emotion: 'warm', gesture: 'open_palms', camera: { shot: 'medium' } },
      { id: 'b2', text: 'Yes — it has truly been an extraordinary day for the newsroom.', emotion: 'confident', gesture: 'nod' } ] },
    { id: 'mid', slug: 'm', storyForm: 'VO', headline: 'STILL DEVELOPING', beats: [
      { id: 'm1', text: 'Some questions, honestly, we just cannot answer quite yet.', emotion: 'thoughtful', gesture: 'shrug', camera: { shot: 'medium' } },
      { id: 'm2', text: 'But we are genuinely grateful that you are here with us tonight.', emotion: 'warm', gesture: 'hand_to_chest' } ] },
    { id: 'sign', slug: 'k', storyForm: 'KICKER', headline: 'GOOD NIGHT', beats: [
      { id: 'k1', text: 'That is all for now. From all of us here — good night.', emotion: 'happy', gesture: 'wave', camera: { shot: 'medium' } } ] },
  ],
};

async function main() {
  const client = new Client({ name: 'gesture-showcase', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry] }));
  log('[showcase] connected');
  const call = async (name: string, args: Record<string, unknown> = {}, t = 300_000) => {
    const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: t });
    if (r.isError) log(`[showcase] ✗ ${name}: ${textOf(r)}`);
    return r;
  };

  log('[showcase] → connect_studio(attended). OPEN http://localhost:5175/?bridge=9777 + click the tab once.');
  log(textOf(await call('connect_studio', { mode: 'attended' })));

  log('[showcase] → set_newscast (gesture reel)');
  log(textOf(await call('set_newscast', { doc: DOC })));
  for (let i = 0; i < 40; i++) { const s = json(await call('get_studio_state')); if (s.avatar && !s.busy) { log(`[showcase] ready · avatar=${s.avatar}`); break; } await sleep(1000); }

  log('[showcase] → generate_backscreen_cards');
  const cards = json(await call('generate_backscreen_cards', {
    headline: 'IN THE NEWSROOM', what: 'A live demonstration of the anchor in motion',
    why: 'Real Mixamo gestures, retargeted to the avatar', numbers: 'Six gestures · one performance',
    quote: 'Good evening, and welcome.',
  }));
  const cardUrls: string[] = cards.urls ?? [];
  const titleCard: string | undefined = cards.cards?.[0]?.path;

  log('[showcase] → build_backscreen_montage');
  log(textOf(await call('build_backscreen_montage', { cards: cardUrls })));
  log('[showcase] → generate_music');
  const music = json(await call('generate_music', { mood: 'calm' }));

  await call('execute_js', { code: "const av=window.__las.avatar; if(av.restToIdle)av.restToIdle(); const s=document.getElementById('shot'); if(s){s.value='medium'; s.dispatchEvent(new Event('change'));} if(window.__las.wallVideo){try{window.__las.wallVideo.currentTime=4;}catch(e){}} return 'framed';" });
  await sleep(2000);

  log('[showcase] → export_mp4 (rendering the reel… keep the tab foreground)');
  const exText = textOf(await call('export_mp4', {}, 300_000));
  log(`[showcase]   ${exText}`);
  const exPath = (exText.match(/(\/\S+\.mp4)/) || [])[1];

  if (exPath) {
    log('[showcase] → post_produce (intro card + music)');
    const post = json(await call('post_produce', { inputMp4: exPath, introCard: titleCard, musicWav: music.path, introSeconds: 3 }));
    log(`[showcase] ✓ FINAL → ${post.path || JSON.stringify(post)}`);
    if (post.path) writeFileSync('/tmp/showcase-FINAL.txt', post.path);
  }
  log('[showcase] ✅ DONE');
  await client.close();
  process.exit(0);
}
main().catch((e) => { log(`[showcase] FAIL: ${String(e)}`); process.exit(1); });
