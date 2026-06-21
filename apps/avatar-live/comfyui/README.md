# ComfyUI model-creation pipeline

The first half of the avatar pipeline (image → 3D) runs in ComfyUI; the second half
(rig + internals → studio) runs in Blender. This folder holds the ComfyUI graphs.

```
Nano Banana (Gemini)            ComfyUI                         Blender (MCP)
front/back/left/right  ──►  hunyuan3d_4view.json  ──► GLB ──►  auto-rig + graft-internals  ──► studio
(prompts/nano-banana-anchor.md)  (Hunyuan3D 3.1)                (scripts/*.py)
```

## Stage 1 — reference images (Nano Banana / Gemini)
Generate **4 consistent T-pose views** of the anchor on a plain `#d9d9d9` background:
**front, back, left profile, right profile**. Exact prompts + rules are in
[`../prompts/nano-banana-anchor.md`](../prompts/nano-banana-anchor.md). Save the 4
PNG/JPGs.

## Stage 2 — image → 3D (`hunyuan3d_4view.json`)
Import this graph into ComfyUI and load the 4 images into the 4 `LoadImage` nodes:

| LoadImage | wires to Tencent input |
|---|---|
| front  | `image` |
| back   | `image_back` |
| left   | `image_left`  ← **added (was empty)** |
| right  | `image_right` ← **added (was empty)** |

`TencentImageToModelNode` settings (verified good): **model 3.1**, **face_count
500000**, **generate_type Normal**, **texture on** (saves diffuse + metallic +
roughness + normal). 4-view is the big fidelity gain over the original front+back
file — it fixes the guessed side/profile geometry. Outputs a textured GLB
(`SaveGLB`) + the PBR maps (`SaveImage`).

This is the Tencent **cloud** API node, so no self-hosting is needed — generate in
ComfyUI, then rig in Blender.

## Stage 3 — rig + internals (Blender)
Take the GLB into Blender (live via the Blender MCP) and run, in order:
1. **auto-rig** — scale/align to Avaturn's skeleton, similarity-fit the arms
   (fingers attached), decimate, automatic weights, cap to 4 influences, add a
   `Jaw` bone. (Recipe in the repo history / memory.)
2. [`scripts/graft-internals.py`](../scripts/graft-internals.py) — graft Avaturn's
   teeth + tongue into the mouth so it opens onto real teeth.
3. Export GLB → `public/<id>-model/{model.glb,config.json}` → auto-discovered in
   the studio (jaw-bone lip-sync).

> Hunyuan3D outputs a hollow outer shell — it cannot generate teeth/eyeballs/mouth
> cavity. Those are added in Stage 3 (Blender), not in ComfyUI.
