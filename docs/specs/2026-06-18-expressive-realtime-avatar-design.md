# Expressive Realtime Avatar — DSL-Driven Motion & Emotion

- **Status:** Draft for review
- **Date:** 2026-06-18
- **Project:** LiveAvatarStream — realtime conversational avatar
- **Scope of this spec:** Phase 1 (expressive motion). Phases 2–3 are designed-for but deferred.

## Context

The realtime conversational avatar already works end-to-end: mic → STT → director LLM (Claude via OpenRouter) → streaming XTTS voice → MuseTalk lip-sync → WebRTC stream (Cloudflare SFU). The director already emits a performance DSL per segment — `emotion` (10 values), `gesture` (10), `posture` (5) — defined in `packages/protocol/src/dsl.ts` (`ScriptSegment` / `StreamedSegment`).

**The gap:** the realtime renderer ignores that DSL. In `services/gpu/realtime/generate.py`, `RealtimeGenerator.generate()` reads only `text`/`language` and lip-syncs every segment onto a single `idle.mp4` base via MuseTalk. So the avatar never visibly changes emotion, gesture, or posture during a live conversation.

## Goal

Make the live avatar visibly perform: react with facial emotion, body gesture, and posture that match the director's DSL, plus an attentive "listening" pose while the user speaks — without adding speech latency. Latency model is "fast first, richer catches up" (balanced). Input is voice (mic), as today.

## Non-goals (deferred / out of scope)

- **Dynamic scene visuals / B-roll** (overlaying generated images while talking) — designed-for via a future optional DSL `visual` field, but NOT built now.
- **Realtime generative motion model** (synthesizing novel expressive video from audio+emotion on the fly) — no open model is viable at sub-second latency today.
- **Neural face/expression rig** (continuous blendshape-level emotion control) — possible later refinement on top of this design.

## Chosen approach: motion-state clip library + DSL-driven base-clip switching

Pre-build a small per-avatar library of expressive base loops (generated with EchoMimicV3), preprocess each once in the MuseTalk worker, and switch the base clip per segment based on the director's `emotion`/`gesture`/`posture`. MuseTalk continues to do lip-sync; the clip choice supplies the visible emotion + gesture + posture. Switching among pre-prepared clips is an O(1) index select, so there is no per-turn warmup and no added speech latency.

### Alternatives considered (and rejected for now)

- **Realtime generative motion model** — highest expressiveness, but not viable at realtime latency / cost with current open models; research-grade stability.
- **Neural face/expression rig** — finer facial control, but still needs clips for body gestures and carries integration + likeness risk; better as a later enhancement.

## Architecture

### Build-time (per avatar)

- Extend `services/gpu/avatar-build/pipeline.py` to generate the motion-state loops with EchoMimicV3, reusing the DSL→prompt mapping in `services/gpu/avatar-video/dsl_map.py` and the EchoMimicV3 invocation in `services/gpu/avatar-video/models.py`. Each clip is a short, loopable segment (~4–6s) from the avatar reference, conditioned to the target state.
- All clips share the same camera framing / background as the idle base so switching is visually continuous.
- Store clips on the `/workspace` volume; MuseTalk-preprocess each (latents/masks) and cache, exactly as the idle base is cached today.

### Motion-state set (~8–12 clips)

idle_neutral, listening (attentive, slight lean-in), explaining (open palms, upright — default talking), emphatic (point/count, leaning in, confident/excited), warm_happy (warm/happy), serious (serious/concerned, hand-to-chest), thoughtful (thoughtful, turned slightly), greeting (wave), affirm (nod / thumbs-up), surprised. (Final list tunable during build.)

### DSL → clip mapping

A mapping table (extends the `dsl_map.py` idea) collapses the 10×10×5 DSL space to the nearest available clip. Gesture wins when explicit (wave→greeting; point/count→emphatic; nod/thumbs_up→affirm; shrug→thoughtful; hand_to_chest→serious/thoughtful by emotion; open_palms/explain→explaining); otherwise fall back by emotion (happy/warm→warm_happy; excited→emphatic; serious/concerned/sad→serious; thoughtful→thoughtful; surprised→surprised; confident→affirm/explaining; neutral→explaining/idle).

### Runtime (per session)

- `services/gpu/realtime/musetalk_worker.py`: extend `prepare` to accept multiple `{clip_id, video_path}` and hold the prepared structures keyed by `clip_id` in VRAM (H100 80GB has headroom; bound by clip count × length). `infer` takes a `clip_id` + audio and selects the matching prepared avatar, keeping a per-clip frame index for continuity.
- `services/gpu/realtime/generate.py`: `RealtimeGenerator.generate(segment)` reads `emotion/gesture/posture`, maps to a `clip_id`, and passes it to `head.step()`.
- **Listening state:** in `services/gpu/realtime/runtime.py`, while STT is capturing the user, emit the `listening` loop instead of the static idle cycle.
- **Crossfade:** when the clip changes between segments, blend the last frame of the old clip with the first frames of the new one over ~5 frames to avoid a jump. Prefer switching at segment/sentence boundaries.
- **Director tuning:** adjust the director system prompt (`buildDirectorSystemPrompt`, used in `services/control-api/src/director.ts`) so the LLM varies emotion/gesture across a turn (e.g., a greeting wave on first contact) to exploit the library.

### Protocol

No schema change required for Phase 1 — the DSL already carries `emotion/gesture/posture`. Reserve an optional `visual` field on `StreamedSegment` for the deferred scene-visuals phase; do not add it yet.

## Data flow

```
mic → STT → director LLM (streams DSL segments: text + emotion/gesture/posture)
   → per segment: XTTS voice  +  DSL→clip_id select
   → MuseTalk lip-sync onto the selected pre-prepared clip (crossfade on switch)
   → AvFrames (video + aligned 16k audio) → WebRTC publish
while user speaks: listening clip loops
```

## Latency model (balanced)

Clips are pre-prepared at session warm, so a switch is O(1). Speech still starts immediately on the loaded clip; the emotion/gesture-matched clip applies from its segment with no measurable added latency. Default the loaded clip to `explaining`/`greeting` so even the first turn is expressive.

## Risks & mitigations

- **VRAM for multiple prepared clips** — bound clip count/length; measure on the H100; trim the set if needed.
- **Continuity / jump on clip switch** — same framing/background across clips + crossfade + switch only at boundaries; bridge through neutral if needed.
- **EchoMimicV3 likeness drift / per-avatar build time** — offline and acceptable; QA each generated clip; regenerate poor ones.
- **Director under-varying the DSL** — prompt tuning + a small validation pass.
- **Crossfade artifacts** — tune blend length; fall back to a hard cut at neutral frames.

## Success criteria / how to verify

- In a live multi-turn session on the H100 pod, the avatar visibly: waves/greets on opening, leans in and gestures when emphatic, holds an attentive listening pose while the user talks, and shifts facial emotion to match the director's DSL.
- No added speech-start latency vs. the current build; clip transitions are smooth (no jarring jumps).
- `/health` stays clean; session teardown releases all prepared clips (no VRAM leak).
- Extend `services/gpu/realtime/validate_loop.py` / `validate_improvements.py` to assert the selected `clip_id` matches the segment DSL across a scripted multi-turn run.

## Phasing

1. **Phase 1 (this spec):** motion-state library generation + multi-clip MuseTalk prep + DSL-driven clip switching + listening state + crossfade + director tuning + live pod validation.
2. **Phase 2 (deferred):** dynamic scene visuals / B-roll overlay (optional DSL `visual` cue + async SDXL via `services/gpu/image-gen` + frame-overlay compositor with catch-up).
3. **Phase 3 (deferred):** neural face/expression-rig refinement + further polish.
