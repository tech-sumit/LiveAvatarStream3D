# Newscast Authoring Guide — Framing, Choreography & On-Screen Graphics

**Date:** 2026-06-27

How to author a `NewsReportDoc` that renders as a natural-looking news report in the
avatar-live studio: the anchor's **framing** and **choreography**, and the **video-wall
slide deck**. This is practical, mechanism-level knowledge — every claim below is grounded
in how the studio actually resolves the DSL, with file references so you can verify.

> Vocabularies live in `packages/protocol/src/dsl.ts` and `newsreport.ts`. Regenerate the
> JSON schema after changing them: `npm run protocol:schema`.

---

## 1. The authoring loop

1. Write a `*.newscast.json` (`NewsReportDoc` v2) — see `apps/avatar-live/public/samples/`
   (`gpt56-rollout.newscast.json` is the reference using every feature here).
2. Load it into the studio: the **Load** button (or drop the file) routes through
   `projectStore.importNewsReport` → `compileNewsReport` → `applyProject`.
3. **Preview** (Speak) to check it live, then **Export MP4** for the frame-exact render.
   Live and export drive the **same** path, so what you preview is what you export.

A doc is `meta` (anchor, voice, fps, aspect) + `defaults` + a `rundown` of **sections**,
each with **beats** (one spoken sentence each). Per-beat you set `emotion`, `gesture`, and
`camera`; per-section you set the **slide** (`headline`, `bullets`, `ticker`, `graphic`).

---

## 2. Framing (camera) — the single most important lever

The anchor stands at a fixed spot **screen-left, video-wall screen-right** (an
"anchor-left / screen-right" set; `scene/studio.ts` `SCREEN_STAND_POS`). You direct the
camera per beat with `camera: { shot, move }`.

### The 6 shots collapse to 3 framings

`CameraShot` has six values, but `compileNewsReport` buckets them to three preset cameras
(`newsreportCompile.ts` `shotFor`/`cameraTypeFor`), and those resolve to fixed framings
(`timeline/catalog.ts`):

| You write (`shot`) | Bucket | Preset | What it frames |
|---|---|---|---|
| `medium` (or anything not below) | medium | `cam.anchor` | **Balanced two-shot — anchor left, screen right.** The news look. |
| `close_up`, `medium_close`, `extreme_close_up` | close | `cam.close` | Tight head & shoulders. Crops the screen out of frame. |
| `wide`, `full` | wide | `cam.wide` | Full studio wide. Pulls back; the anchor skews small/right with dead space. |

**Recommendation: use `medium` for almost everything.** It is the only framing that
composes the anchor-beside-the-screen two-shot cleanly. In testing, `wide`/`full` skewed
the anchor hard to frame-right with empty space, and `close_up`/`medium_close` cropped
uncomfortably into the face and dropped the screen. Reserve the others for a deliberate,
brief beat — not the default.

> **Gotcha:** `medium_close` buckets to **close**, not medium. It is a tight shot, not a
> slightly-tighter medium.

### Camera `move` is mostly ignored

In the NewsReport path only `move: orbit_left` / `orbit_right` does anything (→ `cam.orbit`,
a slow arc). `dolly_*`, `pan_*`, `truck_*`, `pedestal_*` are **not wired** — they compile to
the static framing. Don't author moves expecting a dolly; you'll just get the shot.

---

## 3. Choreography (gestures + idle motion)

Gestures resolve three different ways (`performer-core/src/resolveGesture.ts` +
`timeline/catalog.ts`). This is why some look calm and some look theatrical:

| Gesture | Mechanism | Looks like |
|---|---|---|
| `none`, `explain` | **talk base** — no overlay clip | Calm; arms mostly at sides. **Default for a news anchor.** |
| `point`, `count` | **IK aim** — the arm aims at a target | `point` turns the anchor *toward the screen* → can swing them off-camera. |
| `wave`, `nod`, `open_palms`, `hand_to_chest`, `thumbs_up`, `shrug` | **library clip** — a full body animation | Broad arm motions. Reads theatrical in a medium two-shot. |

**Recommendation: keep `gesture: "none"` for nearly every beat.** Reserve clip/IK gestures
for a single deliberate moment. A news anchor is mostly still; broad arms every sentence is
the #1 thing that makes the result feel unnatural.

`emotion` drives the **face** only (`EMOTIONS` in `dsl.ts`). Pick by tone: `serious` /
`concerned` for hard news, `confident` for a claim, `warm` for the sign-off. It does not
move the body.

### `idleMotion` and the talk-animation caveat

`defaults.idleMotion` (`avatar/avatarController.ts`):
- `false` (default) — the avatar holds still between sentences (no breathing/sway). Calmer.
- `true` — plays the idle/talk cycle for subtle life, but **occasionally gesticulates**.

**Caveat:** even with `idleMotion: false`, the **talk body animation that plays while the
anchor is speaking** can still throw an occasional wide-arm gesture. That motion is the
speaking clip, not a gesture or idle sway, and is **not controllable from the newscast**
today. Expect the anchor to be calm most of the time with an occasional hand movement
mid-sentence. Removing it entirely would require a studio/avatar code change (a calmer talk
clip or suppressing body gesticulation during narration).

---

## 4. On-screen graphics — the video-wall slide deck

The wall is a slide deck that **changes per section**, synced to the narration (added
2026-06-27; `scene/studio.ts` `setSlide`, driven through the unified score path via a
`graphics` cue track and `ScoreDrive.advanceSlide`). Each **section** becomes a slide:

```jsonc
{
  "id": "models", "slug": "three-new-models",
  "headline": "Three New Models",
  "bullets": [
    "Sol — the flagship model",
    "Terra — balanced, for everyday use",
    "Luna — faster and lower-cost"
  ],
  "ticker": "GPT-5.6 LINEUP  ·  SOL  ·  TERRA  ·  LUNA",
  "graphic": { "kind": "url", "src": "/samples/gpt56/03-models.jpg" },
  "beats": [ /* ... */ ]
}
```

What renders on the wall (`drawSlide` in `studio.ts`):
- **Backdrop:** `graphic` image, cover-fit, with a legibility scrim. **Omit `graphic` and it
  falls back to the gradient** — slides always render, image or not.
- **Kicker chip** (red, "LIVE" by default), **headline**, up to **3 bullets**, and the
  **ticker** bar.

### The ticker

`ticker` resolves per slide as `section.ticker ?? defaults.ticker ?? <derived from headline>`.
Set `defaults.ticker` for a show-wide strap and override `section.ticker` per section. This
replaced a **hardcoded** ticker string (the old "REALTIME 3D ANCHOR · BROWSER-RENDERED …"
that never changed) — always author it from the story.

### Backdrop images

- `graphic.kind: "url"` → a path under `apps/avatar-live/public/` (e.g.
  `/samples/gpt56/03-models.jpg`); `"r2"` → an R2 key (resolved at import).
- Design them **dark, abstract, non-text, with negative space** so the overlay reads. The
  GPT-5.6 set was generated with Flux (Comfy Cloud) at 16:9; prompts emphasized "deep blue,
  empty negative space on the left, no text, no people."
- Images **preload before the export frame loop** (`performer.ts`), so they appear in the MP4.

---

## 5. Recipe — a natural news report

```jsonc
{
  "version": 2,
  "meta": { "anchors": [{ "id": "ava", "name": "Ava Lin",
            "avatarUrl": "avaturn-model", "voiceId": "EXAVITQu4vr4xnSDxMaL" }],
            "fps": 30, "aspect": "16:9" },
  "look": { "preset": "broadcast" },
  "defaults": {
    "emotion": "neutral",
    "idleMotion": false,                                  // calmer anchor
    "camera": { "shot": "medium", "move": "static" },     // balanced two-shot everywhere
    "ticker": "TOP STORY  ·  …  ·  MORE AT THE BREAK"
  },
  "rundown": [
    { "id": "open", "slug": "cold-open", "headline": "…",
      "bullets": ["…", "…", "…"],
      "graphic": { "kind": "url", "src": "/samples/<topic>/01.jpg" },
      "beats": [
        { "id": "o1", "text": "Good evening. …",
          "emotion": "serious", "gesture": "none",
          "camera": { "shot": "medium", "move": "static" } }
      ] }
    /* one section per story block; 2–3 short beats each */
  ]
}
```

Rules of thumb: `medium` everywhere · `gesture: "none"` (reserve one deliberate gesture max)
· `idleMotion: false` · 2–3 bullets per section · author the ticker from the story · one
dark abstract backdrop per section.

---

## 6. Vocabulary reference (`packages/protocol/src/dsl.ts`)

- **Emotions:** neutral, warm, happy, excited, serious, concerned, sad, confident, thoughtful, surprised
- **Gestures:** none, wave, point, open_palms, count, thumbs_up, nod, shrug, hand_to_chest, explain
- **Camera shots:** wide, full, medium, medium_close, close_up, extreme_close_up *(→ 3 framings, §2)*
- **Camera moves:** static, dolly_in/out, truck_left/right, pan_left/right, pedestal_up/down, orbit_left/right *(only `orbit_*` honored, §2)*
- **Looks** (`look.preset`): broadcast, flat, cinematic, warm, noir

---

## 7. Pitfalls (learned the hard way)

- **`wide`/`full` skew the anchor to frame-right with dead space** — they're not "establishing
  shots" here; use `medium`.
- **`close_up`/`medium_close` crop the face and drop the screen** — avoid for an anchor.
- **`point` turns the anchor toward the screen, away from camera** — don't use it as a generic
  emphasis gesture.
- **Clip gestures (`wave`/`nod`/`open_palms`/`hand_to_chest`/…) throw the arms wide** — sparing use only.
- **The speaking talk-animation gesticulates even with `idleMotion: false`** — occasional and
  not newscast-controllable (§3).
- **Camera `move` (except orbit) does nothing** in the NewsReport path (§2).
- **The ticker must be authored** — there is no longer a hardcoded fallback string worth relying on.
- **Single exported frames during speech catch mid-phoneme mouth shapes** — judge motion from the
  video, not one still.

---

## Related

- `scene/studio.ts` — wall slide renderer (`setSlide`, `drawSlide`, `preloadSlideImages`)
- `packages/protocol/src/newsreport.ts` / `newsreportCompile.ts` — the DSL + compiler
- `app/scoreDrive.ts` / `app/performer.ts` — the unified live==export drive path
- `app/timeline/catalog.ts` — `shot`/`motion` preset → camera/body resolution
- `apps/avatar-live/public/samples/gpt56-rollout.newscast.json` — the reference newscast
