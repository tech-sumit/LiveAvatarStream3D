# LiveAvatarStream — Product Spec

> **Historical (pre-2026-06-26)** — describes the earlier multi-path product. See the root
> README and `docs/specs/` for the current 3D-browser-only studio.
>
> This spec covers the earlier 2D GPU talking-head generation + realtime streaming paths. The repo was
> consolidated and is now a **browser-only 3D talking-avatar studio**: `apps/avatar-live`
> renders a lip-synced Three.js avatar and exports MP4 client-side (WebCodecs); there is no
> GPU render server. The 2D (EchoMimicV3) + MuseTalk realtime paths moved to
> `../LiveAvatarStream`; the headless `engine-three` renderer was removed. The journeys below
> that involve GPU talking-head rendering (J3 as described) or realtime streaming (J4) no
> longer apply here. See `ARCHITECTURE.md` (scope note), `CLAUDE.md`, and
> `docs/specs/2026-06-25-performance-score-dsl-design.md`.

## Vision

An internal, self-hostable tool that turns a short **reference video** of a person plus a **voice sample** into a reusable digital avatar, then drives that avatar two ways:

1. **Offline generation** — author a script (with gesture / posture / emotion direction) and render a finished **1080p talking-head video** with the cloned voice.
2. **Realtime streaming** — hold a live, two-way conversation with the avatar where a large "director" LLM (Claude Opus 4.8 by default) streams the gesture/posture/emotion **DSL** in realtime, and the avatar speaks + acts it out with sub-second responsiveness.

The bar is **HeyGen-grade realism** with the **highest practical generation speed**. The system is a Cloudflare control plane plus an external H100 GPU plane.

> Scope note (historical): this was built as an **internal tool**. In that era there was intentionally no auth, multi-tenant isolation, consent/watermarking, billing, or public hardening in scope; access was via VPN / port-forward for demos. Those were deferred at the time, not designed out.

## Personas

| Persona | Needs | Primary surface |
|---|---|---|
| Creator / operator | Build an avatar, clone a voice, generate marketing/explainer videos from scripts | Web app (asset + script flows) |
| Conversation designer | Wire the director LLM so the live avatar behaves on-brand | Web app (realtime session), director prompt config |
| Platform engineer (us) | Run the control plane + GPU pool, control cost, swap models | Deploy scripts, ops notes |

## User journeys

### J1 — Build an avatar from a reference video
1. Record (webcam) or upload a 30s–2min portrait/half-body clip.
2. Service validates framing/lighting/face quality, extracts identity, builds an `AvatarProfile` (keyframes + idle-motion + embedding).
3. Optional: kick off a per-avatar LoRA/adapter fine-tune for maximum fidelity (async).
4. Avatar appears in the library, ready to drive.

Fallback tier: generate an avatar still from a text prompt (FLUX/SDXL) or upload a single image — lower realism ceiling, faster.

### J2 — Clone a voice
1. Upload or record a 10–30s clean voice sample.
2. Service extracts a speaker embedding / voice weights, stores them, and returns a TTS smoke clip to confirm the clone.

### J3 — Generate an offline video
1. Pick an avatar + voice.
2. Author a **DSL script**: ordered segments, each with `text` and optional `emotion`, `gesture`, `posture`, `emphasis`, `pause`. An "LLM-assist" button drafts the DSL from a plain prompt.
3. Submit. Watch live job status. Get a downloadable **1080p mp4**.

### J4 — Talk to the avatar live
1. Open a realtime session, grant mic.
2. Speak. STT → director LLM streams DSL → cloned-voice TTS → talking-head video → browser, with working **barge-in** (interrupt the avatar mid-sentence).
3. Target feel: it responds in ~1s and the lip-sync/motion feels live (<150ms steady-state).

## The script DSL (user's view)

A script is a list of **segments**. Each segment is one beat of speech plus how it should be performed:

```json
{
  "segments": [
    {
      "seq": 0,
      "text": "Hey — great to finally meet you.",
      "emotion": "warm",
      "gesture": "wave",
      "posture": "leaning_in",
      "emphasis": ["finally"],
      "pause_ms_after": 250
    }
  ]
}
```

- `emotion`, `gesture`, `posture` are picked from **fixed vocabularies** (see `ARCHITECTURE.md`) so the LLM can emit them reliably and the GPU layer can map them to model conditioning.
- In realtime, the director LLM emits the same segment shape, **streamed** beat-by-beat, so speech + motion start before the full turn is written.

## Feature scope

### MVP (offline first)
- Reference-video avatar build (+ image/upload fallback).
- Voice clone + TTS smoke.
- DSL script editor + LLM-assist draft.
- Offline render pipeline → 1080p mp4 with finishing chain.
- Live job status + download.

### Then (realtime)
- Cloudflare Realtime SFU media path (WHIP/WHEP, NVENC).
- Warm H100 pool + session orchestrator (Durable Object).
- Streaming STT → director LLM DSL → streaming TTS → realtime talking-head → light finishing.
- Barge-in / interruption.

### Quality + performance (continuous)
- Per-avatar fine-tune tier.
- Finishing chain (face restore + super-res + RIFE) to true 1080p.
- Inference optimization (TensorRT/FP8, torch.compile, CUDA graphs, batching, warm models).
- Quantitative eval harness gating model choices.

## Non-goals (for now)
- Auth, accounts, multi-tenant isolation.
- Consent capture, watermarking, content moderation (deferred during the internal-tool era; not a stance for a public release).
- Billing, quotas, public sign-up.
- Polished dashboards / alerting.
- Mobile native apps.

## Success metrics

| Dimension | Target |
|---|---|
| Output resolution | True 1080p, 30–50 fps |
| Lip-sync | Sync-C above premium-tier threshold (set empirically in Phase 3) |
| Identity fidelity | ArcFace cosine vs reference above threshold; no visible drift over a 2-min clip |
| Visual quality | FID/FVD below the budget recorded in the eval report |
| Offline speed | Gen-time per minute-of-video target met on the chosen tier |
| Realtime — media | <150 ms steady-state motion-to-photon |
| Realtime — response | ~0.8–1.5 s to first spoken word; barge-in cancels in <300 ms |

## Open-source / licensing posture

The intent is an open, self-hostable tool. Even though the current build is internal, model selection avoids license traps that would block a future open release: prefer permissive weights (Fish Audio S2 Apache, CosyVoice, Kokoro, Dia2) and **flag non-commercial models** (e.g. F5-TTS CC-BY-NC) as off-by-default. The full license matrix lives in `ARCHITECTURE.md`.
