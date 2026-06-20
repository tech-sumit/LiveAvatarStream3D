# Making 3D avatars with our skeleton (open-source, standardized in Blender)

> Question this answers: **"Can we use open-source models/APIs to make 3D avatars with the skeleton we need, standardizing the skeleton (in Blender) before import?"**
>
> Scope: avatars for the SuVi AI News three.js talking-head platform. Target contract: **GLB, full-body, ARKit-52 + Oculus-15 viseme blendshapes, on ONE canonical RPM/Mixamo-compatible humanoid skeleton in T-pose**, so a single shared set of idle/talk/gesture clips retargets onto every avatar.
>
> Verified against current (Jun 2026) docs/repos. Licenses and realism are called out honestly. Where a claim is from a vendor doc vs. a paper-only feature, it's flagged.

---

## 1. Short answer

**Yes — with caveats.** You can build a fully open, Blender-scriptable pipeline that emits avatars hitting the exact contract above, and it can run headless via `bpy`. The honest caveats:

- **Skeleton + blendshapes: solved openly.** Standardizing every avatar onto one canonical RPM/Mixamo skeleton + T-pose in Blender is a deterministic, scriptable, license-clean step. ARKit/Oculus blendshapes can be transferred from a license-clean donor with open tools.
- **Photorealism is where open falls short.** Fully-open generators (MPFB/MakeHuman, FLAME-family, the image-to-3D models) give **game-character / stylized-realistic** heads, not news-anchor photoreal skin and hair. For that look you either accept a paid *source* (Avaturn / MetaPerson / RPM) and use Blender only to **standardize**, or you do heavy manual look-dev.
- **The biggest landmine is licensing, not capability.** The most "on-target" research tools (FLAME 2020, EMOCA/SMIRK assets, Make-A-Character, SMPL-X, PanoHead/Next3D backbones) are **non-commercial research-only**. The doc below routes around them.
- **The cheapest correct path is to copy an existing reference.** Ready Player Me already ships our exact contract (Mixamo-compatible skeleton + ARKit + Oculus visemes in one GLB). Use it as the **canonical skeleton definition** even if you generate avatars elsewhere. The open Blender pipeline is the fallback for fully-controlled / non-RPM-looking heads.

This is not theoretical for this repo: `apps/avatar-live` **already consumes** this contract. `avatarController.ts` detects a retargetable humanoid by checking `bones.has('Hips') && bones.has('Head') && (LeftArm||RightArm)` and binds one shared clip set by bone name; `morphRig.ts` already maps face channels across ARKit camelCase (RPM/Avaturn), ARKit underscore (facecap), and Oculus visemes. The pipeline below produces inputs that drop straight into that.

---

## 2. The skeleton decision: one canonical skeleton + T-pose

**Decision: every avatar is conformed to ONE canonical humanoid skeleton in T-pose before import. That skeleton is the Ready Player Me / Mixamo bone set.** One shared idle/talk/gesture clip library then retargets onto all avatars by bone name with zero per-avatar re-authoring (modulo a small runtime offset, see below).

### RPM ≈ Mixamo (the practical rule)

They are the **same hierarchy and bone names** — with **one** difference that causes ~90% of retarget bugs:

- **Mixamo** FBX uses the `mixamorig:` **prefix**: `mixamorig:Hips`, `mixamorig:Spine`, `mixamorig:Spine1`, `mixamorig:Spine2`, `mixamorig:Neck`, `mixamorig:Head`, `mixamorig:LeftArm`, `mixamorig:LeftForeArm`, `mixamorig:LeftHand`, `mixamorig:LeftUpLeg`, ... (+ full fingers).
- **Ready Player Me** uses the **same names with NO prefix**: `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftUpLeg`, ... under a root object literally named **`Armature`**.

> **Practical rule:** Pick **plain PascalCase, no prefix** (the RPM convention) as canonical, because that is what this repo and `met4citizen/TalkingHead` (the reference architecture for exactly this product) expect — full-body GLB, Mixamo-compatible rig, root object `Armature`, ARKit-52 + Oculus-15. Then the **only** rename step you ever need is **strip the `mixamorig:` prefix** when ingesting Mixamo-authored clips/rigs. Author the shared clips against this canonical skeleton once.

Three more invariants that must hold for "one shared clip set" to actually work:

1. **T-pose rest pose** (arms straight out, not A-pose). Many generators emit A-pose; you must rotate arms to T and **apply-as-rest BEFORE skinning is frozen**, or the shared clips look broken.
2. **Same bone roll / joint orientation** as the clips were authored against (glTF stores one bind pose per skin — changing rest pose means re-baking skin matrices).
3. **Meters, Y-up, scale 1.0** (RPM convention). Apply transforms.

Where exact bone-roll/proportions differ slightly per source, you do **not** re-bake — you apply a small per-avatar **runtime retarget offset**. This is the proven design: `met4citizen/TalkingHead` ships a `retarget` option (per-bone pos/rot offsets + `scaleToHipsLevel`/`scaleToEyesLevel`), and our `avatarController.ts` already drops tracks for bones a given skeleton lacks (e.g. Avaturn has no fingertip bones) rather than failing.

---

## 3. Recommended OPEN pipeline (stage by stage)

Five stages. Tools named per stage with license. "Open" = the all-open lane; the photoreal lane (§5) swaps stage 1.

```
[1] GENERATE geometry  →  [2] STANDARDIZE skeleton (Blender)  →
[3] ARKit/Oculus blendshapes (Blender)  →  [4] GLB export  →  [5] our import-avatar
```

### Stage 1 — Generate the avatar (head/body geometry)

| Option | License | Realism | Notes |
|---|---|---|---|
| **MPFB2 (MakeHuman Plugin for Blender)** ⭐ open core | Plugin AGPL/GPL; **exported character output is CC0** (commercially usable) | 2/5 game-char | **Best fit for an open, scriptable, in-Blender generator.** Active 2026 (v2.0.16). `mpfb.services.humanservice.HumanService.create_human()` is stateless → headless batch. Has a dedicated **Mixamo rig preset** and a GameEngine (no breasts) rig that is Unity-Mechanim humanoid. Its **Export Copy** panel can bake **54 ARKit face units** (`jawOpen`, `eyeBlinkLeft`, `browDownLeft`, ...) **+ 15 Meta/Oculus visemes** (`viseme_aa`, `viseme_CH`, ...) directly — so it can cover stages 1+3 in one tool. Caveat (per MPFB issue tracker): combining the Mixamo body rig with the face shape keys needs care; do the shape-key bake on the Export Copy. |
| Hunyuan3D-2.1/2.5 | **NOT permissive** — custom "Tencent Hunyuan 3D Community License"; ≤1M MAU, and **excludes EU/UK/South Korea** | 4/5 | Best open *general* image/text-to-3D mesh (2.5 has animation-friendly quad-ish retopo). UNRIGGED, no blendshapes. Geometry source only. Treat license as restricted-commercial, not free. |
| TRELLIS / TRELLIS.2 | **MIT** (some deps separate terms) | 3/5 | Permissive image-to-3D, PBR, native GLB. UNRIGGED, no blendshapes, dense irregular topology → needs retopo. Not human-specialized. |
| InstantMesh / Unique3D | **Apache-2.0 / MIT** (truly permissive) | 2–3/5 | Cheap permissive geometry baselines; outclassed on fidelity. UNRIGGED, no blendshapes. |
| CharacterGen | Apache-2.0 | 2/5 (stylized) | Standout: outputs a **pose-canonical A-pose** body, which helps downstream rigging. OBJ/VRM (convert to GLB in Blender). Stylized/anime-leaning. |
| FLAME 2023 Open (head donor + parametric face) | **CC-BY-4.0 (commercial OK w/ attribution)** | 4/5 basis | Use as the **ARKit donor head** (§3 stage 3), not the shipped geometry. 5023-vert parametric head. **Do NOT use FLAME 2020 / the FLAME texture-albedo space commercially** (non-commercial). |
| FLAME-regressing recon (SMIRK / EMOCA / DECA / MICA) | **Code:** SMIRK = MIT; others non-commercial. **FLAME assets:** non-commercial unless you swap in FLAME 2023 Open | 3/5 | Single-image → FLAME params. Good for capturing a *likeness/expression* from a photo. "MIT code" does **not** clear commercial use of the result — the FLAME model assets carry their own license. SMIRK is the strongest permissive code choice for expression capture. |

**Recommendation for the open lane: MPFB2 as the generator** (CC0 output, scriptable, and it already does ARKit + Oculus visemes). Reach for FLAME 2023 only when you need photo-driven likeness or a clean ARKit donor head.

> Avoid for commercial: Make-A-Character (research/demo, MetaHuman skeleton), SMPL-X / HumanGaussian / PIXIE (Max Planck non-commercial + non-Mixamo skeleton), PanoHead / Next3D (NVIDIA EG3D research license propagates; also NeRF, no clean mesh). These are research frontiers, not product inputs.

### Stage 2 — Standardize the skeleton (Blender, scriptable)

If stage 1 already produced a Mixamo-named, T-pose, skinned rig (MPFB Mixamo preset, RPM, Avaturn), this stage is just **conform + verify**. If stage 1 produced an unrigged mesh (Hunyuan/TRELLIS/etc.), you first **auto-rig**, then conform.

| Step | Tool | License | Notes |
|---|---|---|---|
| Auto-rig an unrigged mesh | **UniRig** (VAST-AI, SIGGRAPH'25) | **MIT** (weights on HF) | Best open auto-rigger; predicts skeleton + skinning for arbitrary meshes. **Caveat: emits its OWN topologically-valid skeleton, NOT Mixamo names / guaranteed T-pose** → you must add a rename+conform pass (below). Headless CLI + Blender addon. |
| Auto-rig (humanoid-specialized) | **HumanRig** (CVPR'25) or **Make-It-Animatable** (CVPR'25) | MIT / research-only (verify repo LICENSE) | HumanRig trains on a **uniform skeleton over T-posed meshes** → the remap to Mixamo is a fixed one-time mapping (code release was in-progress — watch the repo). Make-It-Animatable targets a consistent Mixamo-style template in <1s but has **no ARKit face** (body only) and research-flavored license. |
| **Rename → canonical + enforce T-pose** ⭐ | **Blender Rigify + Retarget extension / Bone Shop / `mixamo_converter`** + plain `bpy` | **GPL/AGPL (free)** | The deterministic, headless, license-clean **standardization glue**. Pure `bpy` bone-rename to/from `mixamorig:`, plus "Replace Namespace" to strip the prefix. This is where you force ANY rigged mesh onto the exact RPM bone naming + T-pose. |
| (Paid alternative glue) | Auto-Rig Pro + Remap | ~$40, paid | Built-in Mixamo/Rokoko retarget presets + namespace replace; `bpy.ops`-callable but no documented batch API. Use only if the free Rigify/Retarget path proves insufficient. |

> **Bone-naming ground truth:** Adobe **Mixamo** is the source of the `mixamorig:` convention and sets T-pose, but it's **not scriptable (web only), no GLB, body-only (strips facial blendshapes on upload since ~2020)**. Use it as the *naming reference*, not an automated stage.

### Stage 3 — ARKit-52 + Oculus-15 blendshapes (Blender, scriptable)

If you used MPFB Export Copy, you already have them. Otherwise transfer from a license-clean **donor** head onto your avatar head:

| Tool | License | Notes |
|---|---|---|
| **ShapeKeyWrap** ⭐ | **GPL-3.0 (free)** | Recommended open core. ~100 lines over Blender's **Surface Deform** modifier: pick the avatar head(s), make a **donor ARKit head active**, transfer its 52 shape keys. Topology-tolerant (binds by surface proximity). `bpy`-loopable over many heads headlessly. |
| **TransferAllShapeKeysViaSurfaceDeform** | MIT-ish | Minimal, dependency-free reference you can **vendor directly into this repo** as a build step. Same mechanism. |
| **deformation_transfer_ARkit_blendshapes** (vasiliskatr) | **MIT** | Higher fidelity (Sumner et al. per-triangle deformation transfer, not just proximity). Documented workflow uses Wrap3D (paid) for the NRICP fit — substitute an **open NRICP** (open3d) to stay fully open. |
| **FLAME 2023 Open** as the **donor** | **CC-BY-4.0** | The clean commercial donor: synthesize the 52 ARKit poses on a FLAME 2023 head, use that as the Surface-Deform donor. Avoids buying Faceit/Polywink. (The mediapipe→FLAME *mapping* repo is research-only; the FLAME 2023 geometry + a hand-built ARKit pose set is clean.) |
| FLAME → ARKit conversion math | NVIDIA Audio2Face-3D paper (Aug 2025) | The only documented **FLAME→ARKit** (correct direction) converter: 103-dim FLAME → 51-dim ARKit MoE net. **Standalone open weights not confirmed** — treat as a reproducible blueprint, not a dependency. |
| (Paid alternatives) | Faceit ($99), Polywink (per-model), Fiverr (~$100/model) | Turnkey but GUI/per-asset; fine for a hero avatar, wrong for volume. |

> **Naming caveat:** MediaPipe's 52 blendshapes share ARKit's names/semantics. ARKit underscore (`mouthSmile_L`) vs camelCase (`mouthSmileLeft`) both appear in the wild — this repo's `morphRig.ts` already normalizes both plus Oculus visemes, so emit either consistently and verify against that map.

### Stage 4 — GLB export (Blender glTF, scriptable)

Bundled Khronos exporter (`glTF-Blender-IO`, GPL, in Blender 4.x/5.x). Headless: `blender --background --python conform.py -- in.glb out.glb`.

```python
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_morph=True,
    export_morph_normal=True,
    export_skins=True,
    export_rest_position_armature=True,   # export rest (T-pose), not current frame
    export_animations=False,              # ship avatars clip-free; clips are shared/separate
    export_yup=True,
)
```

### Stage 5 — Our import-avatar

The GLB drops into `apps/avatar-live`. `avatarController.ts` auto-detects the humanoid (`Hips`+`Head`+arm), binds the shared clip set by bone name (dropping tracks for missing bones), and `morphRig.ts` binds face channels to whatever ARKit/Oculus morphs are present. Validate: bones present? T-pose rest? morphs named per the map? Then verify the talk clip drives the jaw/visemes.

---

## 4. Concrete Blender pipeline + gotchas

**Yes, it runs headless.** Everything above is `bpy`-scriptable; MPFB's `HumanService` is stateless and the glTF exporter, Rigify/Retarget rename, and Surface-Deform transfer are all operator-driven. A single batch script:

```
blender --background --python build_avatar.py -- \
        --params face.json --donor donor_arkit_flame2023.glb --out avatar.glb
```

`build_avatar.py` outline:

1. **Generate** — `HumanService.create_human(...)`; apply the **Mixamo rig preset**. (Or import a generated/unrigged mesh and run UniRig, then rename.)
2. **Conform skeleton** — rename bones to canonical (strip `mixamorig:`), rotate arms to **T-pose**, **apply pose-as-rest**, apply transforms (scale→1.0, meters, Y-up).
3. **Blendshapes** — append donor head, Surface-Deform transfer the 52 ARKit + 15 Oculus shape keys onto the avatar head (or MPFB Export Copy bake).
4. **Export** — `export_scene.gltf(...)` with the flags above.
5. **Validate** — assert `Hips/Spine/Spine1/Spine2/Neck/Head/LeftArm/...` present, rest pose ≈ T, morph dict contains the named set.

**Gotchas to script around (these are where it breaks):**

1. **A-pose vs T-pose** — rotate arms to T **and apply-as-rest BEFORE skinning is frozen**. Do it after and the shared T-pose clips deform wrong.
2. **One bind pose per skin (glTF)** — changing rest pose requires re-baking skin matrices; do skeleton conform *before* finalizing skinning.
3. **Bone roll / joint orientation** differs per source rig — author the shared clips against the canonical roll, or recompute roll on conform. Mismatch = subtly twisted limbs.
4. **`mixamorig:` prefix** — the #1 retarget bug. Standardize on **no-prefix RPM names**; strip on Mixamo ingest.
5. **Scale/units** — RPM is meters, Y-up, scale 1.0. Apply transforms; bake scale to 1.0.
6. **Mixamo strips facial blendshapes** on upload — never route a blendshape'd head through the Mixamo web rigger; rig the body, re-attach shapes after in Blender.
7. **Export flags** — forget `export_morph`/`export_rest_position_armature` and you ship a frozen face or a current-frame "rest" pose.
8. **RPM dual-morph download friction** — RPM forum reports (late 2025) of trouble pulling **ARKit + Oculus Visemes simultaneously** via `morphTargets=`. If you source from RPM, verify both groups are actually present in the downloaded GLB (request `morphTargets=ARKit,Oculus+Visemes,Default`).

---

## 5. Honest verdict: where open falls short, and when to just buy the source

**Where fully-open is genuinely good enough:**
- The **skeleton standardization** stage — deterministic, free, scriptable, license-clean. There is no reason to pay here.
- The **ARKit/Oculus blendshape** stage — Surface-Deform / deformation-transfer from a **FLAME 2023 (CC-BY-4.0)** donor is open and commercial-clean.
- **Stylized / game-character realism** avatars (MPFB, RPM-look) — fully covered.

**Where fully-open falls short:**
- **Ultra-photoreal skin & hair (news-anchor grade).** Open generators top out at game-character/stylized-real. The photoreal research models (PanoHead, Next3D, HRN) are NeRF/GAN with **no clean rigged mesh** and/or NVIDIA/Alibaba **research licenses** — not product inputs. Open + heavy manual look-dev can get close, but it's expensive labor.
- **Research-only licenses bite hardest on the most "on-target" tools:** FLAME 2020 + texture/albedo space (non-commercial), EMOCA/DECA/MICA/PIXIE (Max Planck non-commercial), SMPL-X (non-commercial *and* non-Mixamo skeleton), Make-A-Character (research/demo, MetaHuman skeleton). "MIT code on a non-commercial model" (SMIRK) does **not** clear the result. Route through FLAME 2023 Open or avoid.

**When to just use a paid source + Blender only to standardize:**

If you need **photoreal news-anchor faces with low effort**, stop trying to generate them openly. Use a paid selfie-to-3D source that **already ships our contract**, then use the open Blender pipeline only for the deterministic **conform** (strip prefix / enforce T-pose / verify morphs):

| Source | License | Realism | Ships our contract? |
|---|---|---|---|
| **Ready Player Me** | Free to use; commercial via RPM ToS (Netflix-owned 2025) | 3/5 stylized-real | **Yes** — GLB, Mixamo-compatible no-prefix skeleton + `Armature` root, ARKit-52 + Oculus-15 via `morphTargets=`. **The canonical reference.** |
| **Avaturn** | Paid for commercial (free non-commercial) | 4/5 | **Yes** — GLB, standard humanoid rig, ARKit + visemes, explicitly Mixamo-compatible. Most photoreal of the turnkey lot. |
| **Avatar SDK / MetaPerson** | Paid Cloud API | 4/5 | **Yes** — GLB/FBX, 51 ARKit blendshapes, Mixamo-usable humanoid. Backup commercial lane. |
| Meshcapade (Me API) | Paid | 3/5 | Legal commercial SMPL path, but **SMPL skeleton ≠ Mixamo** (retarget step) and ARKit not confirmed. Weaker fit. |

For these, the Blender step is **conform-only** (~stage 2+4), not generate. That's the pragmatic recommendation for a hero/anchor avatar.

---

## 6. "Build this" recommendation for THIS repo

Concretely, given `apps/avatar-live` already implements the consumer contract:

**Worth scripting now (high leverage, low risk):**

1. **`tools/conform-avatar.py`** — headless `blender --background` script that takes any humanoid GLB and emits a canonical one: strip `mixamorig:` → enforce T-pose/apply-as-rest → apply transforms → export with the flags in §4. This is the deterministic glue every other path feeds into, it's license-clean (GPL Blender), and it directly de-risks RPM/Avaturn/MetaPerson sources and any generated mesh. **Do this first.** Validate it against an RPM GLB (the contract reference) and against `met4citizen/TalkingHead`'s requirements.
2. **Vendor `TransferAllShapeKeysViaSurfaceDeform`** (MIT) + a **FLAME 2023 Open donor head** with the 52 ARKit poses baked, as a `tools/transfer-blendshapes.py` step. Gives a commercial-clean, repeatable ARKit/Oculus blendshape transfer onto any head — no Faceit/Polywink spend.
3. **A 5-assert validator** (bones present, T-pose rest, morph names match `morphRig.ts`, GLB loads in three.js, talk clip drives jaw) wired as a CI-style gate. Cheap, catches the §4 gotchas before they reach `engine-three`/`avatar-live`.

**Worth doing as a generator (medium effort):**

4. **MPFB2 batch generation** (`HumanService.create_human` + Mixamo preset + Export Copy ARKit/Oculus) as the **open, controlled** avatar source for non-photoreal anchors. CC0 output. This is the "fully open lane" and it's real.

**NOT worth scripting now (skip / defer):**

- **Auto-rig integration (UniRig/HumanRig/Make-It-Animatable).** Only needed if you generate **unrigged** meshes (Hunyuan/TRELLIS). If your sources (MPFB/RPM/Avaturn/MetaPerson) are already rigged, this is dead weight. Defer until you actually need a custom-geometry, unrigged source — and even then it's GPU+ML-heavy with a mandatory rename pass after.
- **Open photoreal head generation (FLAME recon, PanoHead, Next3D, HRN).** Licenses and/or no-clean-mesh make these poor product inputs. For photoreal, buy the source (§5) and conform.
- **NVIDIA FLAME→ARKit MoE net** — blueprint only; weights/license unconfirmed. Don't build a dependency on it.
- **Per-avatar retarget re-baking.** Don't. Use the **runtime offset** approach the codebase + TalkingHead already prove (small per-bone pos/rot offset, drop missing tracks). Keep ONE shared clip set authored against the canonical skeleton.

**Bottom line:** Build the **conform + blendshape-transfer + validator** trio now (script #1–3). Add MPFB batch generation (#4) for the open lane. Source photoreal anchors from Avaturn/MetaPerson/RPM and run them through the same conform step. Don't build auto-rig or open-photoreal-head generation until a concrete need forces it.

---

## 7. Driving Blender live from Claude Code (Blender MCP) — VERIFIED

This repo is wired to drive Blender directly (inspect/modify/export avatars from chat), which is how the `conform-avatar` pipeline above is developed + run.

**Setup (one-time):**
1. `.mcp.json` (committed) registers the server: `blender → uvx blender-mcp`.
2. Install the Blender addon: download `addon.py` from
   [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) (rename to a
   module-safe name, e.g. `blender_mcp_addon.py`), then in Blender →
   Preferences → Add-ons → Install from Disk → enable **Blender MCP**. (Verified
   loading on Blender 5.1.2; addon targets 3.0+.)
3. Open Blender (GUI) — the addon auto-starts a socket on `127.0.0.1:9876`. Keep
   Blender open while using it.
4. In Claude Code, `/mcp` → connect/approve the **blender** server.

**Verified round-trip (Jun 2026):** drove Blender to import `mpfb-model/model.glb`
→ read its 67 bones + 67 ARKit shape keys → framed + screenshotted the viewport →
exported GLB → validated through `scripts/import-avatar.mjs` (66 morphs, lip-sync
✓, humanoid skeleton ✓). Confirmed visually that MPFB ships an **A-pose** (not the
canonical T-pose) — the root cause of its body-anim distortion (§2 invariant #1),
which `conform-avatar.py` will fix.

Available MCP tools include `get_scene_info`, `execute_blender_code`,
`get_viewport_screenshot`, `get_object_info`, plus generation bridges
(`generate_hyper3d_*`, `generate_hunyuan3d_model`, `search_sketchfab_models`,
`*_polyhaven_*`) — the generation ones need their respective API keys enabled in
the Blender addon's panel.
