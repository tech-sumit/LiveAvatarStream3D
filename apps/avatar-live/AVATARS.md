# AVATARS.md — Acquiring 10 Ultra-Realistic, Platform-Compatible Avatars

> Platform: `apps/avatar-live` — a browser three.js news-anchor talking head.
> Avatars are driven by `MorphFaceRig` (`src/avatar/morphRig.ts`), which binds an
> avatar-agnostic `FaceChannels` set onto whatever morph targets a GLB exposes.
>
> **An avatar is COMPATIBLE only if its GLB carries facial morph targets** the rig
> can bind. Verified from source, the rig recognizes these name families per channel:
>
> | Channel    | Accepted morph names (first match wins)                                                  |
> |------------|------------------------------------------------------------------------------------------|
> | `jawOpen`  | `jawOpen` / `JawOpen` / `mouthOpen` / `viseme_aa`                                         |
> | `mouthWide`| `mouthStretchLeft/Right` / `mouthStretch_L/_R` / `viseme_E`,`viseme_I`                    |
> | `mouthRound`| `mouthFunnel` / `mouthPucker` / `viseme_O`,`viseme_U`                                    |
> | `mouthClose`| `mouthClose` / `viseme_PP` / `mouthPressLeft/Right` / `mouthPress_L/_R`                  |
> | `smile/frown`| `mouthSmileLeft/Right` (`_L/_R`), `mouthFrownLeft/Right` (`_L/_R`)                      |
>
> Names are normalized (lowercased, separators dropped, `Left/Right ↔ _L/_R` folded),
> so **ARKit camelCase, ARKit underscore, and Oculus visemes all bind**. If
> `boundCount` (jawOpen+mouthWide+mouthRound) is **0**, the rig falls back to a jaw-bone
> open/close or procedural head — that is the **"weak / unusable for a news anchor"** path.
>
> An avatar is therefore WEAK if it has only a jaw bone or no blendshapes.

## The platform's avatar contract (verified against the code)

Each avatar lives at:

```
public/<id>-model/
  ├── model.glb        # the avatar
  └── config.json
```

and its `<id>-model` string is appended to the registry array in `public/avatars.json`.

`config.json` schema (exact fields the loader reads):

```json
{
  "label": "Human-readable name (dropdown)",
  "description": "One line shown in the UI",
  "model": "model.glb",
  "shot": "close | medium | wide",
  "lipsync": { "gain": 1.0, "jaw": 1.0, "wide": 1.0, "round": 1.0, "smoothing": 0.2 }
}
```

- `shot` controls camera distance (`close`=tight head, `medium`=head+shoulders, `wide`=full body). News anchors → **`medium`** (or `close` for head-only meshes).
- `lipsync.*` scale the channels; defaults of `1.0` (smoothing `0.2`) are a good start. For visemes that over-articulate, drop `jaw`/`wide`/`round` to ~`0.8`.

---

## 1. Ranked shortlist of routes

Ranked by: actually photoreal × confirmed bind-able morphs × license that allows shipping × low friction to reach 10.

| # | Route | Photoreal | Morphs (verified) | License for an app | Friction to 10 | Verdict |
|---|-------|-----------|-------------------|--------------------|----------------|---------|
| **1** | **Avaturn T2** (selfie→GLB) | ★★★★ | ARKit + Oculus visemes, **native GLB** | Free tier = **non-commercial only**; commercial ships need **Pro $800/mo** (≤1,000 avatars/mo, +$0.15 extra) — *verified live on avaturn.me/pricing* | **Lowest** — 10 selfies → 10 GLBs via SDK | **Best overall.** Photoreal, drop-in GLB, morphs guaranteed. Must pick **T2** (T1 has no face morphs). |
| **2** | **Avatar SDK / MetaPerson 2.0** (photo→GLB REST API) | ★★★★ | `mobile_51` (ARKit-compatible) + `visemes_15/17`, **embedded in GLB** | No permanent free tier (~1-wk trial); **Pro $800/mo, 6,000 avatars/mo, +$0.03 extra** — *verified live on avatarsdk.com/pricing-cloud* | **Lowest** — REST loop, fully scriptable | Strongest if you'll batch hundreds; cheaper per-avatar overage than Avaturn. **Verify exact morph-name casing on first export** (`mobile_51` may need a thin remap). |
| **3** | **MetaHuman → GLB+ARKit bake** (UE 5.7 → Blender/Holotype) | ★★★★★ | ARKit-52 camelCase after bake (OSS `metahuman-to-glb`, Holotype plugin) | **Now permits "any engine or creative software"** incl. web/glTF — *verified on metahuman.com/license*. Free under $1M/yr revenue. **Caveat:** EULA forbids using MetaHumans to **train/enhance an AI model** (runtime LLM-driving is fine; harvesting frames as training data is not). | **High** — UE install + per-head bake | **Best realism, now legally viable for web** (the old "render only in Unreal" blocker is gone). Use only if you need broadcast-grade and can pay the bake-pipeline tax. |
| **4** | **Reallusion CC5 + Headshot 3 → Blender → GLB** | ★★★★★ | ARKit-52 after applying perfect-sync/ExPlus profile + rename | CC Standard license **does NOT cover embedding into an app/service** → likely **Enterprise (quote-only)**. *Confirm with Reallusion before shipping.* | High (Blender round-trip + rename) | Top realism, fully supported export, **but the app-embedding license is the blocker.** |
| **5** | **KeenTools FaceBuilder (photo→head) + FaceIt (ARKit) → GLB** | ★★★★★ | ARKit-52 (authored by FaceIt — **you own the output**) | **Clean & royalty-free**: KeenTools "everything you create is yours" ($18/mo or $179/yr); FaceIt ~$78 perpetual, no per-output royalty | High (manual Blender per head) | **Best license + best realism**, but most hand-work. Use for 1–2 hero anchors, not for batch-10. |
| **6** | **facecap.glb** (three.js example) | ★★★ | **Full ARKit-52 camelCase — verified in `webgl_morphtargets_webcam.html`** | **MIT** (ships in three.js `/examples`) | **Zero** — already in repo | Already bundled. Great free **head-only stand-in / test fixture**, not anchor-grade. |
| **7** | **Microsoft Rocketbox + HeadBox** (FBX→GLB) | ★★ | 52 ARKit + 15 visemes via HeadBox, after FBX→GLB | **MIT — best license of the set** | Medium (FBX→GLB convert × N) | Bundle-anywhere safe, but **game-character fidelity**, not photoreal. Backup only. |

### Do NOT waste time on these (incompatible or non-photoreal or license-dead)

- **Ready Player Me** — service **shut down Jan 31 2026** (Netflix acquisition). No new avatars; old ones are CC-BY-NC (non-commercial). Stylized, not photoreal. **Dead.**
- **Eisko "Louise"** — **CC-BY-NC-ND**: NonCommercial **and** NoDerivatives. The FBX→GLB/decimate/remap you'd need are derivatives → **forbidden**. 20M polys too heavy. Reference only.
- **MetaHuman head on Gumroad (dragonboots)** — FBX, "free," but it's MetaHuman-derived with **no license grant on the page**; rely on the official MetaHuman license path (route #3) instead, not this listing.
- **NVIDIA "Claire" (Omniverse USD)** — Omniverse EULA, not bundle-able; USD→GLB + unverified morph names. Reference only.
- **Pinscreen / Genies** — Pinscreen is **neural-rendered/streamed, no GLB export**; Genies is **Unity-only, stylized, no GLB+ARKit export**. Both **incompatible** with a three.js GLB rig.
- **VRoid Studio** — **anime/stylized (photoreal 1)**, ARKit morphs must be hand-added (HANA_Tool). Disqualified for a news anchor.
- **Meshcapade / SMPL-X** — body/mocap focus; facial control is FLAME-style PCA bases, **not ARKit/Oculus names**. Not a drop-in head.
- **Polywink** — produces ARKit-52, but their commercial license lets you ship **animations, not the blendshape mesh itself** — shipping the morph-target GLB in a web app is exactly what they restrict. FaceIt (route #5) is cleaner because you own the output.
- **Sketchfab "Rigged T-Pose Male w/ 50 blendshapes"** — CC-BY (bundle-able), but **diffuse-only texture → not photoreal**, and the 50 morphs are **not confirmed ARKit-named** (needs inspection/remap). Backup at best.
- **Human Generator** — good mesh source, but **no ARKit morphs out of the box** → must run FaceIt anyway (treat as a mesh source, like KeenTools).

---

## 2. "Get 10 now" recipe — single fastest path

**Fastest path = Avaturn T2.** Native GLB with ARKit + Oculus visemes, no Blender, no conversion. Ten stock portrait photos → ten compatible GLBs.

> ⚠️ **License gate:** Do this on the **free developer tier for evaluation/non-commercial only.** Shipping these avatars in the public news-anchor product **requires the Pro plan ($800/mo)** — verified on avaturn.me/pricing. Don't bundle free-tier Avaturn GLBs into a shipped commercial build.

### Step-by-step

1. Sign up at **developer.avaturn.me** (free dev tier).
2. Collect **10 front-facing, neutral, well-lit portrait photos** (licensed stock or your own; diverse for an anchor lineup).
3. Integrate the SDK to drive the creator (or use the hosted iframe manually 10×):
   ```bash
   npm i @avaturn/sdk
   ```
   ```js
   import { AvaturnSDK } from '@avaturn/sdk';
   const sdk = new AvaturnSDK();
   await sdk.init(container, { url, iframeClassName: 'sdk-iframe' });
   sdk.on('export', (data) => downloadGlb(data.url)); // data.url → finished GLB
   ```
4. In the creator, upload a selfie and **select the T2 avatar type** (separate eyeballs + mouth cavity). **This is the critical choice** — T1 is more photoreal but has a **static face with no morphs** and is **incompatible**. Only **T2** carries ARKit + visemes.
5. On "Next"/export, the SDK fires `export` with `data.url` → download/persist the GLB. Repeat for all 10.
6. **Verify each GLB before accepting it** (don't trust, check):
   ```js
   // quick node/browser check
   gltf.scene.traverse(o => {
     if (o.isMesh && o.morphTargetDictionary)
       console.log(Object.keys(o.morphTargetDictionary));
   });
   // PASS if you see jawOpen + (viseme_aa OR mouthFunnel/mouthPucker) + mouthStretch*/viseme_E
   ```
   Or just load it in the app — `MorphFaceRig` logs a warning and falls back to jaw-bone if `boundCount === 0` (`main.ts:111`). A clean load with visemes = compatible.

### Fallbacks (in order)

- **Avaturn export uses Draco/meshopt compression?** The app already ships decoders (`public/decoders/draco/`, `public/decoders/basis/`) — GLTFLoader is configured for them, so compressed GLBs load fine.
- **Need a fully scriptable batch / cheaper overage** → **Avatar SDK MetaPerson REST** (route #2): `POST /avatars/` with `export_parameters` `{"format":"glb","blendshapes":{"list":["mobile_51","visemes_15"]}}`, loop 10×. Verify morph casing on the first GLB; add a tiny remap table if names aren't literal ARKit camelCase.
- **Need it free + zero-friction right now (test/dev)** → use **facecap.glb** (already in repo, MIT) plus **`mpfb.glb`** from met4citizen/TalkingHead (CC0) to fill slots while you license a paid source.
- **Need broadcast-grade hero anchor** → **MetaHuman bake** (route #3) or **KeenTools+FaceIt** (route #5) for 1–2 heads.

---

## 3. Blender authoring fallback (FaceIt) — when a source has no ARKit morphs

Use this for any photoreal head **mesh** that lacks blendshapes (KeenTools FaceBuilder output, Human Generator, a scan, a CC export without the ARKit profile). FaceIt bakes the **52 ARKit-named shape keys onto your mesh, and you own the output** (no per-output royalty).

1. **Get FaceIt** (Superhive, ~$78 perpetual) and install in Blender.
2. **Import/build the photoreal head** in Blender (e.g. KeenTools FaceBuilder: load 3–5 neutral photos, auto-fit, one-click texture).
3. **FaceIt → Setup:** register the **Main (head)**, **Eyes**, **Teeth**, **Tongue** objects.
4. **Place the landmark guides** on the face (eyes/mouth/jaw) so FaceIt knows the topology.
5. **Generate the FaceIt rig.**
6. **Shapes/Expressions tab → choose the ARKit preset → bake** the 52 shape keys. Set names/order to the **ARKit standard** so you get `jawOpen`, `mouthSmileLeft`, `mouthStretchLeft/Right`, `mouthFunnel`, `mouthPucker`, `mouthClose`, `eyeBlinkLeft`, `browInnerUp`, etc.
7. **Verify in Blender:** the head mesh's *Object Data → Shape Keys* lists 52 ARKit-named keys.
8. **Export:** `File → Export → glTF 2.0 (.glb)` with **"Shape Keys (morph targets)" ON**, +Y up. (Optional Draco — the app supports it.) For a browser anchor, **set face mesh in neutral rest** and keep textures ≤2K for close-ups.
9. **Confirm in three.js:** load in the app; `MorphFaceRig` should report a non-zero `boundCount` and lip-sync should work.

> Even though the rig only *drives* jaw/wide/round/close/smile/frown, baking the full ARKit-52 is fine and future-proofs `applyNamed()` (A2F-3D / ARKit frame playback).

---

## 4. Integration steps for THIS platform (per recommended avatar)

For **every** avatar, the drop-in is identical — only the config values differ:

```bash
# 1. Create the model dir
mkdir -p public/<id>-model
# 2. Drop the GLB (must be named model.glb)
cp /path/to/your.glb public/<id>-model/model.glb
# 3. Write config.json (see per-avatar values below)
# 4. Register it in the runtime array
#    add "<id>-model" to public/avatars.json
```

`public/avatars.json` is a JSON array; append the new id, e.g.:
```json
["avatarsdk-model","avaturn-model","brunette-model","facecap-model","anchor-ava-01-model"]
```

### Per-avatar config.json templates

**Avaturn T2 (route #1)** — head-and-shoulders anchor, ARKit + visemes:
```json
{
  "label": "Anchor — Ava (Avaturn T2)",
  "description": "Photoreal selfie-built anchor, ARKit + Oculus visemes",
  "model": "model.glb",
  "shot": "medium",
  "lipsync": { "gain": 1.0, "jaw": 0.9, "wide": 0.9, "round": 0.9, "smoothing": 0.2 }
}
```

**Avatar SDK / MetaPerson (route #2)** — photoreal head, ARKit + visemes:
```json
{
  "label": "Anchor — Mira (MetaPerson)",
  "description": "Photoreal head-from-photo, ARKit + visemes (embedded)",
  "model": "model.glb",
  "shot": "medium",
  "lipsync": { "gain": 1.0, "jaw": 1.0, "wide": 1.0, "round": 1.0, "smoothing": 0.2 }
}
```

**MetaHuman bake (route #3)** — broadcast-grade, ARKit-52 camelCase, often head-only after bake:
```json
{
  "label": "Anchor — Daniel (MetaHuman)",
  "description": "Broadcast-grade MetaHuman, ARKit-52 (baked to GLB)",
  "model": "model.glb",
  "shot": "close",
  "lipsync": { "gain": 1.0, "jaw": 0.85, "wide": 0.85, "round": 0.85, "smoothing": 0.2 }
}
```
> MetaHuman GLBs are Draco-compressed (~40MB) — the app's `public/decoders/draco/` handles it. Scale is cm: apply 0.01 on Blender export. Use `close` for head-only bakes.

**KeenTools+FaceIt (route #5)** — hero head, head-only:
```json
{
  "label": "Anchor — Lena (KeenTools)",
  "description": "Photoreal photo-built head, FaceIt ARKit-52",
  "model": "model.glb",
  "shot": "close",
  "lipsync": { "gain": 1.0, "jaw": 0.9, "wide": 1.0, "round": 1.0, "smoothing": 0.25 }
}
```

**facecap.glb (route #6)** — already integrated as `facecap-model` (`shot: "close"`). Keep as test fixture.

> **Tuning note:** viseme-driven avatars (Avaturn/MetaPerson) sometimes over-open — if so, lower `lipsync.jaw`/`wide`/`round` toward `0.8`. ARKit-stretch avatars (facecap/MetaHuman bakes) usually run well at `1.0`. Raise `smoothing` (0.2→0.3) if lips chatter.

---

## 5. Licensing cautions — bundle in repo vs fetch at runtime

| Source | Bundle GLB in the repo? | Notes |
|--------|--------------------------|-------|
| **facecap.glb** | ✅ Yes | MIT (three.js examples). Already in repo. |
| **Rocketbox/HeadBox** | ✅ Yes | MIT. Safest third-party. |
| **MPFB (`mpfb.glb`)** | ✅ Yes | CC0. The only freely-bundlable TalkingHead sample. |
| **KeenTools+FaceIt output** | ✅ Yes | You own the baked output, royalty-free (keep your KeenTools sub active only to *edit*). |
| **Human Generator output** | ✅ Yes (commercial license $128) | Don't redistribute raw HumGen assets; shipping a baked GLB is fine. |
| **Avaturn T2** | ⚠️ Only under **Pro $800/mo** | Free-tier GLBs are **non-commercial** — do **not** commit them to a shipped build. Under Pro you may bundle. |
| **Avatar SDK / MetaPerson** | ⚠️ Under **Pro $800/mo** | Generated avatars usable in your app per commercial terms; confirm plan limits with sales. |
| **MetaHuman GLB** | ⚠️ Yes (license now allows "any engine"), but **not as AI training data** | Free under $1M/yr revenue. Runtime LLM-driving is OK; do not harvest rendered frames to train a model. |
| **Reallusion CC5** | ❌ Not under Standard | App-embedding needs **Enterprise** — confirm before bundling. |
| **Polywink mesh** | ❌ No | License covers shipping animations, not the blendshape mesh. |
| **RPM / Eisko / Omniverse / Pinscreen / Genies / VRoid** | ❌ No | Dead, ND/NC, restricted-format, or no GLB export. |

**General rule:** Bundle only **MIT / CC0 / "you-own-output"** GLBs in git. Anything tied to a paid/commercial-tier license (Avaturn Pro, MetaPerson Pro, MetaHuman) is fine to ship in a build **under that license**, but keep a clear provenance note per `public/<id>-model/` (a `LICENSE.txt` next to `model.glb`). Don't commit non-commercial-tier assets to a public repo.

---

## 6. Recommended concrete plan to reach 10

- **For a shipped commercial product (best value/realism balance):** buy **Avaturn Pro** ($800/mo) → generate **8 T2 anchors** from diverse stock portraits (recipe §2), + **1 MetaHuman** broadcast-grade hero (§3), + keep **facecap** as the free test fixture = **10 compatible avatars**, all morph-verified.
- **For evaluation/prototype now (zero spend):** **facecap.glb** (in repo) + **mpfb.glb** (CC0) + **Rocketbox/HeadBox** (MIT, FBX→GLB ×N) gets you a working 10 immediately, at game-character fidelity — then swap in paid photoreal heads before launch.
- **Always verify** each GLB with the §2 morph check (or watch for the `MorphFaceRig` fallback warning in `main.ts`). A GLB that triggers jaw-bone fallback is **not** anchor-usable.
```

Verification status of the load-bearing claims (checked live, June 2026):
- **facecap.glb = full ARKit-52 camelCase, MIT, in three.js examples** — verified from `webgl_morphtargets_webcam.html` blendshapesMap.
- **Avaturn Pro = $800/mo, ≤1,000 avatars/mo, +$0.15 extra; no free tier shown** — verified on avaturn.me/pricing.
- **Avatar SDK Pro = $800/mo, 6,000 avatars/mo, +$0.03 extra; trial only** — verified on avatarsdk.com/pricing-cloud.
- **MetaHuman license now explicitly allows "any engine or creative software" (web/glTF OK), free under $1M/yr, AI-training restriction stands** — verified on metahuman.com/license. The old "render only in Unreal" blocker from earlier sources is superseded.
- **Platform contract** (config.json schema, `shot` enum, ARKit/underscore/viseme binding, `boundCount`-zero → jaw-bone fallback) — verified from `src/avatar/morphRig.ts`, `face.ts`, `scene/stage.ts`, `main.ts`, and the existing `public/*-model/config.json` files.

Relevant files on this platform:
- `apps/avatar-live/public/avatars.json` (runtime registry)
- `apps/avatar-live/public/<id>-model/{model.glb,config.json}` (per-avatar drop-in)
- `apps/avatar-live/src/avatar/morphRig.ts` (morph binding / compatibility logic)
- `apps/avatar-live/src/avatar/face.ts` (FaceChannels contract)

---

## Importing your own avatars (`scripts/import-avatar.mjs`)

A drop-in pipeline that makes an arbitrary `.glb` **work** on this platform
(rig/morphs/config) — it does **not** restyle geometry or textures.

```bash
npm run import-avatar -- path/to/model.glb --id my-anchor --label "My Anchor" --shot medium
# flags: --body true|false  --no-rename  --dry  --overwrite-config
```

What it does (editing only the GLB's JSON chunk, so Draco/meshopt files are fine):

1. Reads the model's blendshape names and **renames** the conventions the rig
   doesn't already cover (VRM/VRoid `Fcl_*` → Oculus visemes; collision-guarded).
   ARKit camelCase, ARKit `_L/_R`, Oculus `viseme_*` and `mouthOpen` already bind.
2. Prints a **compatibility report**: lip-sync channels covered (jaw/wide/round/
   close) and whether the skeleton is RPM/Mixamo-compatible (→ body animation).
3. Writes `public/<id>-model/{model.glb, config.json}` (auto-discovered). Refuses
   models with no jaw/open channel (a frozen face) and tells you to add ARKit
   blendshapes first (Blender FaceIt).

Then calibrate its lip-sync in the editor's **Lip-sync calibration** panel.

## Custom-face avatars & "face swap" — what's actually feasible

**Can we make new photoreal identities by swapping faces on a base model?**
Not with quality, in-house. A convincing identity swap on a *rigged* head means
fitting a 3D Morphable Model (FLAME/DECA-class) to a photo and synthesizing skin
texture (inpainting/UV) — a real ML pipeline with model weights + datasets, i.e.
re-building what photo-avatar services already do. A naïve texture paste onto the
face UV looks wrong (no landmark fit, seams, lighting mismatch). So: **don't
hand-roll identity face-swap.** Generate custom faces from the source instead
(below), then `import-avatar`.

**Can we re-create Avaturn's avatar maker from "public sources"?**
No — Avaturn's photo→3D models (face reconstruction, texture synthesis, hair,
body, rigging) are **proprietary and not open source**; there is nothing public
to re-create it from. What *is* public is their **SDK**, which **embeds their
hosted creator in an iframe** — you get the finished GLB, not the models. So the
legitimate, low-effort path to "a customize-avatar page on our site" is:

- Add a **Create Avatar** page that embeds Avaturn's official creator
  (`@avaturn/sdk`: photo upload + their styling UI run in the iframe).
- On `export`, the SDK hands back a GLB URL → pipe it through `import-avatar`
  (or the in-app loader) → a new `public/<id>-model/` avatar.
- Requires an Avaturn account/SDK key (free for non-commercial; ~$800/mo to ship
  commercially — see the table above). Same applies to Avatar SDK / MetaPerson,
  which also offer an embeddable creator + API.

This gives exactly the requested capability (custom faces from images + styling,
on our site) using the source's *official* embed — without (illegally/
impractically) cloning their proprietary pipeline.
