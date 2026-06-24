/**
 * Convert a Mixamo FBX animation into a clean, RPM-compatible GLB animation clip.
 *
 * Node's three FBXLoader silently drops compressed keyframe arrays, so we run the
 * (reliable) browser FBXLoader headlessly via Playwright: parse the FBX, strip the
 * `mixamorig:` bone prefix and the root-position tracks (rotation-only retarget by
 * bone name — exactly how avatarController.loadAnimations binds), drop the skin mesh,
 * and re-export just the skeleton + clip as a small GLB. The result binds directly to
 * our RPM/Avaturn avatars, like the ReadyPlayerMe clips.
 *
 * Usage: node scripts/fbx-to-glb.mjs <input.fbx> <output.glb> [clipName]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createServer } from 'node:http';

const [, , inPath, outPath, clipNameArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/fbx-to-glb.mjs <input.fbx> <output.glb> [clipName]');
  process.exit(1);
}
const clipName = clipNameArg || basename(outPath).replace(/\.glb$/i, '');
const fbxBuf = readFileSync(inPath);

const HTML = `<!doctype html><html><head>
<script type="importmap">{"imports":{
"three":"https://unpkg.com/three@0.171.0/build/three.module.js",
"three/addons/":"https://unpkg.com/three@0.171.0/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
window.__convert = async (url, clipName) => {
  const ab = await (await fetch(url)).arrayBuffer();
  const grp = new FBXLoader().parse(ab, '');
  if (!grp.animations.length) throw new Error('no animation in FBX');
  // Mixamo FBX can ship multiple takes (e.g. a 2-frame bind stub + the real motion);
  // pick the longest clip.
  const clip = grp.animations.slice().sort((a, b) => b.duration - a.duration)[0];
  if (clip.duration < 0.1) {
    throw new Error('clip "' + clip.name + '" has no motion (' + clip.duration.toFixed(3) + 's) — this FBX is a static pose or character, not an animation. On Mixamo: Animations tab, pick a clip that PLAYS, download FBX Binary / Without Skin.');
  }
  // Anchor gestures are UPPER-BODY ONLY: keep shoulders/arms/hands + neck/head, and DROP
  // spine/hips/legs so the mocap's weight-shifts, leans, bends and turns don't fold or spin
  // the standing-still anchor. (Position tracks dropped too — rotation-only retarget.)
  const UPPER_BODY = /(Shoulder|Arm|Hand|Neck|Head)/;
  clip.tracks = clip.tracks
    .filter(t => !t.name.endsWith('.position'))
    .filter(t => UPPER_BODY.test(t.name.replace(/^mixamorig:?/i, '').split('.')[0]));
  for (const t of clip.tracks) t.name = t.name.replace(/^mixamorig:?/i, '');
  clip.name = clipName;
  clip.resetDuration();
  // rename bones to clean names so the exporter's track bindings resolve
  grp.traverse(o => { if (o.name) o.name = o.name.replace(/^mixamorig:?/i, ''); });
  // strip skin meshes — we only need the skeleton + clip (keeps the GLB tiny)
  const toRemove = [];
  grp.traverse(o => { if (o.isMesh || o.isSkinnedMesh) toRemove.push(o); });
  toRemove.forEach(m => m.parent && m.parent.remove(m));
  const glb = await new Promise((res, rej) =>
    new GLTFExporter().parse(grp, res, rej, { binary: true, animations: [clip], onlyVisible: false }));
  const out = new Uint8Array(glb); let s=''; const CH=0x8000;
  for (let i=0;i<out.length;i+=CH) s += String.fromCharCode.apply(null, out.subarray(i, i+CH));
  return { b64: btoa(s), dur: clip.duration, tracks: clip.tracks.length };
};
window.__ready = true;
</script></body></html>`;

// Serve the HTML + the FBX locally so the page can fetch the whole file (no arg-size cap).
const server = createServer((req, res) => {
  if (req.url === '/input.fbx') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fbxBuf.length });
    res.end(fbxBuf);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page error]', String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  const r = await page.evaluate(
    async (name) => window.__convert('/input.fbx', name),
    clipName,
  );
  writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
  console.log(`✓ ${basename(inPath)} → ${outPath}  (clip "${clipName}", ${r.dur.toFixed(2)}s, ${r.tracks} tracks, ${(Buffer.from(r.b64,'base64').length/1024).toFixed(0)} KB)`);
} finally {
  await browser.close();
  server.close();
}
