# Hunyuan3D: rigging, internals & animation — what it can and can't do

> Verified deep-research (Jun 2026), cited to primary sources (Tencent repos, arXiv
> papers, license files). Separates the **open** Hunyuan3D 2.1 we run (via the
> ComfyUI Tencent-cloud node) from the **closed** Hunyuan3D Studio platform.

## TL;DR
Hunyuan3D 2.1 — and every **openly-released** Hunyuan generation model — is
**generation-only**: it emits a **static, watertight outer-shell mesh** (marching
cubes from an SDF). **No bones, no skin weights, no internal anatomy (no eyeballs/
teeth/tongue/mouth cavity), no animation, no lip-sync.** That's not a setting we
missed — it's mathematically what the model produces. Rigging/animation exist
*elsewhere* in Tencent's ecosystem (closed Studio platform; the separate HY-Motion
model), but **nothing in the Hunyuan family produces facial blendshapes/visemes**
— the exact thing a talking head needs.

## Q1 — Bones / skeleton / auto-rigging
- **Hunyuan3D 2.1 (what we use):** static mesh only. Ships exactly two models —
  Shape-v2-1 (image→shape, 3.3B) + Paint-v2-1 (PBR texture, 2B). No rig anywhere in
  the code/paper/model-zoo. [1]
- **Hunyuan3D-Omni:** "skeletal pose control" is a **conditioning INPUT** that poses
  the generated mesh — it *consumes* a skeleton, it does **not** output a rig.
  Output is still a static mesh. [3]
- **Hunyuan3D Studio (closed/hosted, built on closed 2.5):** *does* auto-rig —
  template-based **22-joint humanoid** skeleton + per-vertex skinning + motion
  retargeting. Body-level only; **not** in any open weights, and **no facial rig**. [4]
- **HY-Motion-1.0 (Dec 2025):** separate text→3D-human-**motion** model on an SMPL-H
  skeleton (body locomotion/gesture). Body only; **no face/lip-sync**. [5]

## Q2 — Internal anatomy (eyes / teeth / tongue / mouth cavity)
**No — impossible in 2.1 by construction.** The mesh is "extracted at the zero-level
isosurface via marching cubes" from a signed distance field → a single closed outer
surface, no internal organs. No mode changes this. [2]
**Hunyuan3D-Part** (P3-SAM + X-Part) splits a mesh into **structural** parts (car
body vs wheels) — *not* biological internals; "internal regions" there means
completing hidden surfaces of structural parts, not adding eyes/teeth. [6]

## Q3 — Animation / lip-sync
- Generation models: **generation-only.**
- Body animation: **Studio** (auto-rig + retarget) and **HY-Motion** (text→motion)
  — both **body-only**.
- **Facial blendshapes / ARKit visemes / lip-sync: produced by NO Hunyuan model.**
  This is the core gap for a talking anchor and must be filled by other tools. [4][5]

## Q4 — Recommended pipeline (fill the gaps Hunyuan leaves)
```
Hunyuan3D 2.1  → mesh (static shell + PBR)
   │
   ├─ retopology (marching-cubes meshes are dense/non-manifold — clean first)
   ├─ BODY rig:   UniRig (open, SIGGRAPH 2025) → auto skeleton + skinning [7]
   │              (or Mixamo / AccuRig; or Hunyuan3D Studio Auto-Rig if reachable)
   ├─ INTERNALS:  add teeth/tongue + mouth cavity in Blender (no generator does this)
   └─ LIP-SYNC:   Faceit (Blender add-on) → the 52 ARKit blendshapes [8]
                  (or template/morph transfer; or audio→blendshape e.g. Audio2Face)
```
- **UniRig** = one model that outputs **both** a valid skeleton **and** skinning
  weights for an arbitrary mesh — but **no facial rig**. [7]
- **Faceit** = semi-auto creation of the 52 ARKit shape keys on any head mesh →
  real visemes for lip-sync (paid Blender add-on). [8]
- For *our* talking news-anchor: the missing piece vs what we built is **Faceit**
  (real visemes instead of jaw-only open/close). Our current Hunyuan anchor already
  has a body skeleton (Avaturn-fit) + grafted teeth; Faceit would upgrade lip-sync.

## Q5 — Licensing (important for a product)
- **Hunyuan3D 2.1 — Tencent Community License:** commercial use **allowed**, BUT
  **grants no rights in the EU, UK, or South Korea** (hard territorial exclusion),
  and needs a separate Tencent license above **1M monthly active users**. [9]
- **UniRig:** research/SIGGRAPH license (check before commercial shipping). [7]
- **Faceit:** paid commercial add-on. **Mixamo:** Adobe, free for commercial use.

## Caveats
Fast-moving field (facts current Jun 2026). The single biggest trap: most
"Hunyuan can rig/animate" claims online refer to the **closed Studio platform** or
separate models (HY-Motion, Part), **not** the open 2.1 weights we run. Studio's
auto-rig + HY-Motion are **body-only** — neither solves facial lip-sync.

### Open questions worth checking
- Does the ComfyUI Tencent-cloud node expose **Studio's Auto-Rig** (rigged FBX), or
  only the open 2.1 static-mesh path? If reachable, it could auto-produce the body
  skeleton (still not facial visemes).
- Studio's licensing/territory for hosted Auto-Rig output (may differ from the 2.1
  Community License).

## Sources
[1] github.com/tencent-hunyuan/hunyuan3d-2.1 · arXiv:2506.15442
[2] arXiv:2506.15442 (2.1 paper — marching-cubes/SDF)
[3] github.com/Tencent-Hunyuan/Hunyuan3D-Omni · arXiv:2509.21245
[4] arXiv:2509.12815 (Hunyuan3D Studio) · 3d.hunyuan.tencent.com/studio
[5] github.com/Tencent-Hunyuan/HY-Motion-1.0 · arXiv:2512.23464
[6] github.com/Tencent-Hunyuan/Hunyuan3D-Part · arXiv:2509.08643
[7] github.com/VAST-AI-Research/UniRig · arXiv:2504.12451
[8] faceit-doc.readthedocs.io
[9] github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE
