#!/usr/bin/env node
// Import an arbitrary .glb as a platform-ready SuVi avatar.
//
// What it does:
//   • reads the model's morph-target (blendshape) names and renames common
//     conventions (VRM/VRoid "Fcl_*", a few generics) to the ARKit/Oculus names
//     MorphFaceRig binds — so more models lip-sync without hand-editing;
//   • reports which lip-sync channels are covered (jaw / wide / round / close);
//   • detects an RPM/Mixamo-compatible humanoid skeleton → sets bodyAnim;
//   • writes public/<id>-model/{model.glb, config.json} so it's auto-discovered.
//
// It edits ONLY the GLB's JSON chunk (geometry/BIN untouched) → works on Draco/
// meshopt-compressed files. It does NOT restyle geometry/textures: it makes an
// asset *work* (rig/morphs), it cannot make a stylized mesh *look* photoreal —
// that has to come from a photoreal source (Avaturn T2, MetaPerson, MetaHuman…).
//
// Usage:
//   node scripts/import-avatar.mjs <source.glb> [--id NAME] [--label "Text"]
//        [--shot close|medium|wide] [--body true|false] [--no-rename] [--dry]
//   npm run import-avatar -- <source.glb> --id my-anchor

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const optVal = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (k) => args.includes('--' + k);
if (!src) {
  console.error('usage: node scripts/import-avatar.mjs <source.glb> [--id NAME] [--label "..."] [--shot medium] [--body true|false] [--no-rename] [--dry]');
  process.exit(1);
}

// ── GLB parse / repack (JSON chunk only) ─────────────────────────────────────
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a binary glTF (.glb)');
  const version = buf.readUInt32LE(4);
  const chunks = [];
  let json = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    off += 8 + len;
  }
  if (!json) throw new Error('no JSON chunk in GLB');
  return { version, json, chunks };
}
function repackGlb(version, json, chunks) {
  const jsonStr = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonStr.length % 4)) % 4;
  const jsonData = Buffer.concat([jsonStr, Buffer.alloc(pad, 0x20)]);
  const parts = [];
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonData.length, 0);
  jh.writeUInt32LE(CHUNK_JSON, 4);
  parts.push(jh, jsonData);
  for (const c of chunks) {
    if (c.type === CHUNK_JSON) continue; // existing chunks are already 4-byte aligned
    const h = Buffer.alloc(8);
    h.writeUInt32LE(c.data.length, 0);
    h.writeUInt32LE(c.type, 4);
    parts.push(h, Buffer.from(c.data));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

// ── Blendshape name normalization (mirrors src/avatar/morphRig.ts) ───────────
const norm = (n) =>
  n.toLowerCase().replace(/[_\s.]+/g, '').replace(/left$/, 'l').replace(/right$/, 'r');

// best-effort rename for conventions the rig does NOT already cover. (ARKit
// camelCase, ARKit _L/_R, Oculus viseme_* and "mouthOpen" already bind as-is.)
// Best-effort rename ONLY for conventions the rig does not already cover. (ARKit
// camelCase, ARKit _L/_R, Oculus viseme_* and "mouthOpen" already bind as-is, so
// they're deliberately NOT remapped — remapping them would create duplicates.)
const RENAME = {
  // VRM / VRoid coarse mouth expressions → Oculus visemes the rig reads
  fclmtha: 'viseme_aa',
  fclmthi: 'viseme_I',
  fclmthu: 'viseme_U',
  fclmthe: 'viseme_E',
  fclmtho: 'viseme_O',
  fclmthfun: 'mouthSmileLeft',
  fcleyeclose: 'blink',
};
// channel coverage probe (normalized keys the rig accepts per channel)
const CHANNELS = {
  jawOpen: ['jawopen', 'mouthopen', 'visemeaa'],
  mouthWide: ['mouthstretchl', 'mouthstretchr', 'visemee', 'visemei'],
  mouthRound: ['mouthfunnel', 'mouthpucker', 'visemeo', 'visemeu'],
  mouthClose: ['mouthclose', 'visemepp', 'mouthpressl', 'mouthpressr'],
};

// ── inspect + convert ────────────────────────────────────────────────────────
const buf = readFileSync(src);
const { version, json, chunks } = parseGlb(buf);

// collect morph-target name arrays (mesh.extras.targetNames + primitive.extras.targetNames)
const nameArrays = [];
for (const m of json.meshes ?? []) {
  if (Array.isArray(m.extras?.targetNames)) nameArrays.push(m.extras.targetNames);
  for (const p of m.primitives ?? []) if (Array.isArray(p.extras?.targetNames)) nameArrays.push(p.extras.targetNames);
}
const before = new Set(nameArrays.flat().map(String));

let renamed = 0;
if (!flag('no-rename')) {
  const existing = new Set(nameArrays.flat().map((s) => norm(String(s))));
  for (const arr of nameArrays) {
    for (let i = 0; i < arr.length; i++) {
      const cur = norm(String(arr[i]));
      const repl = RENAME[cur];
      // skip if no mapping, a no-op, or the target name already exists (no dups)
      if (!repl || norm(repl) === cur || existing.has(norm(repl))) continue;
      arr[i] = repl;
      existing.add(norm(repl));
      renamed++;
    }
  }
}
const present = new Set([...nameArrays.flat().map((s) => norm(String(s)))]);
const covered = Object.fromEntries(
  Object.entries(CHANNELS).map(([ch, keys]) => [ch, keys.some((k) => present.has(k))]),
);

// skeleton → humanoid?
const boneNames = new Set();
for (const sk of json.skins ?? []) for (const j of sk.joints ?? []) if (json.nodes?.[j]?.name) boneNames.add(json.nodes[j].name);
const humanoid = boneNames.has('Hips') && boneNames.has('Head') && (boneNames.has('LeftArm') || boneNames.has('RightArm'));

// ── report ───────────────────────────────────────────────────────────────────
const id = (optVal('id', basename(src, extname(src))).replace(/[^\w-]+/g, '-') + '-model').replace(/-model-model$/, '-model');
const lipsync = covered.jawOpen;
console.log(`\nImport report for ${basename(src)} → ${id}`);
console.log(`  morph targets:   ${before.size}${renamed ? `  (renamed ${renamed} → ARKit/viseme)` : ''}`);
console.log(`  lip-sync:        ${lipsync ? '✓' : '✗ NO jaw/open channel — needs ARKit blendshapes (e.g. Blender FaceIt)'}`);
console.log(`    jawOpen ${covered.jawOpen ? '✓' : '·'}  wide ${covered.mouthWide ? '✓' : '·'}  round ${covered.mouthRound ? '✓' : '·'}  close ${covered.mouthClose ? '✓' : '·'}`);
console.log(`  body animation:  ${humanoid ? '✓ humanoid skeleton (RPM/Mixamo bones)' : '· no RPM-compatible skeleton → static head'}`);

if (flag('dry')) {
  console.log('\n--dry: no files written.');
  process.exit(lipsync ? 0 : 2);
}
if (!lipsync) {
  console.log('\nRefusing to import: the model has no usable lip-sync channel (frozen face).');
  console.log('Add ARKit blendshapes first (see AVATARS.md → Blender/FaceIt), then re-run.');
  process.exit(2);
}

// ── write avatar folder + config ─────────────────────────────────────────────
const dir = join(PUBLIC, id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'model.glb'), repackGlb(version, json, chunks));
const body = flag('body') ? optVal('body', 'true') === 'true' : humanoid;
const config = {
  label: optVal('label', id.replace(/-model$/, '')),
  description: 'Imported avatar',
  model: 'model.glb',
  shot: optVal('shot', 'medium'),
  bodyAnim: body,
  lipsync: { gain: 1.0, jaw: 1.0, wide: 1.0, round: 1.0, smoothing: 0.2 },
};
if (existsSync(join(dir, 'config.json')) && !flag('overwrite-config')) {
  console.log(`\nWrote ${id}/model.glb (kept existing config.json — pass --overwrite-config to replace).`);
} else {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log(`\nWrote ${id}/{model.glb, config.json}.`);
}
console.log('Restart/refresh the dev server — the avatar is auto-discovered. Calibrate lip-sync in the editor.');
