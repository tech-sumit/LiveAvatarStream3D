# Nano Banana → Hunyuan3D anchor-avatar prompt

Generate **front + back reference images** of a photoreal news anchor with **Nano
Banana** (Gemini image), then feed them to the **Hunyuan3D Image(s)→Model** node
(front → `image`, back → `image_back`) to get a clean, riggable 3D model.

Why a **T-pose** (arms straight out, perpendicular to the torso): it separates the
limbs from the body so image-to-3D reconstructs arms/legs as distinct volumes (not
fused to the torso), and it matches Avaturn's T-pose rest — so the result aligns
with the rig when we wrap/retarget it (`scripts/wrap-to-rig.py`).

---

## Image rules (these make or break the 3D reconstruction)

- **One subject, centered, FULL body** head-to-feet, nothing cropped (hands and
  feet must be fully inside the frame).
- **Exact symmetric T-pose**: both arms extended straight out horizontally at
  shoulder height, perpendicular to the torso; palms forward (front) / away
  (back); fingers straight and together. Clear empty space visible under each arm.
- **Legs straight, small gap between them**, feet shoulder-width and flat.
- **Plain, seamless, uniform light-gray background `#d9d9d9`** — no props, text,
  logos, furniture, or second person.
- **Flat, even, soft frontal studio light**, no harsh shadows (shadows bake badly
  into the texture).
- **Neutral expression, mouth closed, eyes open, looking straight ahead.**
- **Straight-on camera at chest height, minimal perspective** (orthographic feel),
  sharp focus, high resolution.
- **Front and back must be the SAME person**: identical face, hair, wardrobe, pose.

Avoid: dynamic poses, hands on hips, tilted/low/high camera angles, depth-of-field
blur, dramatic lighting, busy backgrounds, accessories, watermarks, cropping.

---

## PROMPT — front view (copy/paste)

```
Full-body photorealistic studio reference photograph of a single professional
television news anchor, standing in a precise, symmetric T-pose: both arms
extended straight out horizontally to the sides at exactly shoulder height,
perpendicular to the torso, palms facing forward, fingers straight and together,
with clear empty space visible beneath each arm; legs straight and parallel with a
small gap between them, feet shoulder-width apart and flat on the floor.
Subject: a 34-year-old anchor, neat shoulder-length dark hair, clean professional
grooming, calm confident neutral expression, mouth closed, eyes open looking
directly into the camera. Wearing a tailored navy business blazer over a white
collared shirt and matching trousers — formal broadcast-news wardrobe.
Flat, even, soft frontal studio lighting with no harsh shadows. Plain seamless
light-gray (#d9d9d9) background, completely uniform, no props, no text, no logos,
no second person. Camera straight-on at chest height, orthographic feel with
minimal perspective distortion; the entire body from head to feet is fully in
frame and centered. Sharp focus, ultra-high resolution. A clean, evenly lit T-pose
reference image suitable for photogrammetry and image-to-3D reconstruction.
```

## PROMPT — back view (copy/paste; run after the front for identity consistency)

```
The exact same person from the previous image — identical face structure, identical
hairstyle, identical wardrobe — now viewed from directly behind (180° rear view) in
the exact same symmetric T-pose: arms extended straight out horizontally at
shoulder height, palms facing away from camera, fingers straight and together;
legs straight with a small gap, feet flat. Show the back of the head and hair, the
back of the navy blazer, the backs of the arms and hands, and the backs of the legs
and heels. Identical flat, even, soft studio lighting and the identical plain
seamless light-gray (#d9d9d9) background. Same framing: full body head-to-feet,
centered, camera straight-on at chest height, minimal perspective. Photorealistic,
sharp, ultra-high resolution, perfectly consistent character identity and wardrobe
with the front view.
```

## PROMPT — left profile (copy/paste; for 4-view reconstruction)

```
The exact same person from the previous images — identical face, hairstyle, and
wardrobe — now viewed from their LEFT side as a true 90° profile (camera to the
person's left, facing the side of the body), in the exact same symmetric T-pose:
arms extended straight out horizontally at shoulder height so the near arm points
toward the camera and the far arm points away; legs straight with a small gap.
Show a clean side silhouette: profile of the nose/chin/forehead, the ear, the side
of the hair, the side of the blazer, hip and leg. Identical flat, even, soft studio
lighting; identical plain seamless light-gray (#d9d9d9) background; same framing —
full body head-to-feet, centered, camera at chest height, minimal perspective.
Photorealistic, sharp, ultra-high resolution, perfectly consistent with the front.
```

## PROMPT — right profile (copy/paste)

```
Same person and wardrobe again, identical to the previous views, now viewed from
their RIGHT side as a true 90° profile (mirror of the left-profile shot), same
symmetric T-pose, same flat even studio lighting, same plain seamless light-gray
(#d9d9d9) background, same full-body centered framing at chest height. Clean side
silhouette of face, ear, hair, blazer, hip and leg. Photorealistic, sharp,
ultra-high resolution, perfectly consistent with the other three views.
```

> Consistency tip: generate the **front first**, then create back/left/right by
> *editing/continuing from that image* ("same character, rear/left/right view")
> rather than fresh prompts — Nano Banana keeps identity far better that way. Reuse
> the same seed. 4 consistent views (front/back/left/right) give Hunyuan3D the best
> reconstruction; 2 (front/back) is the minimum.

---

## Variation slots (build a roster of distinct anchors)

Swap these phrases in the front prompt; keep everything else identical so the set
stays uniform and reconstructs the same way:

- **Gender / age**: `34-year-old` · `man` / `woman` · `late-20s` … `50s`
- **Ethnicity**: e.g. `South Asian`, `East Asian`, `Black`, `Hispanic`, `White`
- **Hair**: `short cropped black hair` · `shoulder-length auburn` · `bald` · `tied-back`
- **Wardrobe color**: `navy` · `charcoal` · `burgundy` · `slate-gray` blazer
- **Build**: `slim` · `average` · `broad-shouldered`

Keep the **pose, background, lighting, framing, and "image rules" fixed** for every
anchor — only vary identity/wardrobe.

---

## Hand-off to Hunyuan3D (per the workflow node)

- Wire all four: **front → `image`**, **back → `image_back`**, **left → `image_left`**,
  **right → `image_right`** (the `TencentImageToModelNode` has all four; using only
  front+back leaves the sides/profile guessed — 4-view is a big fidelity gain).
- Verified-good node settings (from the working run): `model` **3.1**, `face_count`
  **500000**, `generate_type` Normal, **texture on** (saves diffuse + metallic +
  roughness + normal). 500k is heavy but fine — we decimate to ~30–50k for the
  browser during rigging.
- Output GLB → then map onto Avaturn's rig + ARKit blendshapes with
  `blender -b --python scripts/wrap-to-rig.py -- public/avaturn-model/model.glb <hunyuan>.glb public/<id>-model/model.glb`,
  add a `config.json`, and it auto-appears in the studio dropdown.
