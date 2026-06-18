# 3D-Engine Cinematic POC — Workstation / Cloud Runbook

Exact steps to produce the first **offline cinematic 4K** clip of one MetaHuman
on a lit stage, performing our director DSL: fed our TTS audio → ACE
Audio2Face-3D lip-sync + Audio2Emotion, our DSL firing 3 body Animation
Montages, one Sequencer Cine Camera dolly move, rendered to 4K via Movie Render
Queue, audio muxed.

> None of this runs in the LiveAvatarStream coding repo's environment. You need a
> **UE5 + RTX/L40S** workstation or cloud node (Windows or Linux). The in-repo
> deliverables (protocol manifest, control-plane job, render script) are ready;
> this runbook covers the manual engine steps that require that box.

## 0. Hardware / GPU

| Stage | GPU | Why |
|---|---|---|
| **UE5 render (MRQ)** | **RTX 4090 / RTX 6000 Ada / L40S** (24–48 GB) | Path tracing + 4K MRQ needs RealTime ray tracing **and a display/encode engine**. **Do NOT use H100** — it has no NVENC / display engine and is a poor fit for UE rendering. |
| **ACE Audio2Face-3D (local provider)** | RTX-class or **L40S**; H100/L40S fine for pure inference | A2F local-execution providers run on-device on an NVIDIA GPU. Can co-locate on the render box or run separately. |
| **Our TTS / voice clone** | existing H100/L40S GPU plane | Unchanged; reused as-is. |

Cloud options: AWS `g6e` (L40S) / `g5`, GCP `g2` (L40S), CoreWeave/RunPod RTX
6000 Ada or L40S with a desktop/display image. Rough cost: **L40S ≈ $1.5–2.5/hr**
on-demand; a 10–30 s 4K clip with path tracing renders in **single-digit
minutes**, so a POC clip is **well under $1** of GPU time plus setup/idle.

## 1. Install UE5 + the ACE Audio2Face-3D plugin + MetaHuman

1. **Unreal Engine** — install via the Epic Games Launcher.
   - Target **UE 5.7** per the project decision.
   - ⚠️ **Compatibility note (verify at setup time):** the NVIDIA **ACE Unreal
     plugin v2.5 officially supports UE 5.5 and 5.6** (it dropped 5.4). UE 5.7
     may not yet have an official prebuilt ACE plugin. Because the plugin is
     **MIT-licensed open source**, either (a) rebuild it from source against
     5.7, or (b) **fall back to UE 5.6** for the POC if 5.7 is blocked. Pick
     whichever unblocks the first clip fastest; the manifest/render script are
     engine-version-agnostic.
2. **Enable Movie Render Queue** — `Edit > Plugins > Movie Render Queue` (ships
   with UE). Also enable **Apple ProRes Media** output plugin and
   **Python Editor Script Plugin** + **Editor Scripting Utilities**.
3. **MetaHuman** — enable the **MetaHuman** plugin; create/download a MetaHuman
   via MetaHuman Creator or Quixel Bridge and add it to the project content
   (`/Game/LAS/MetaHumans/...`). Note its Blueprint path (e.g.
   `/Game/LAS/MetaHumans/Ada/BP_Ada`).
4. **NVIDIA ACE Audio2Face-3D — MIT, self-hosted, NO Riva.** The Audio2Face-3D
   SDK and the UE5 plugin are **open source under the MIT license** (per NVIDIA's
   Audio2Face-3D GitHub, https://github.com/NVIDIA/Audio2Face-3D — SDK: MIT;
   UE5 plugin: MIT; training framework: Apache). Install **two** UE plugins:
   - **Core ACE plugin** — `NV_ACE_Reference.uplugin`.
   - **Audio2Face-3D Models plugin** — provides the actual model.
   For **fully self-hosted, no-Riva** operation, use a **local-execution
   provider** (e.g. `NvAudio2FaceClaire` / `NvAudio2FaceJames` /
   `NvAudio2FaceMark`, regression or diffusion). These run A2F **on the local
   NVIDIA GPU** with no NVCF/Riva dependency. (The default `RemoteA2F` provider
   instead calls a hosted/remote service — not what we want.) Download links and
   install steps are on the ACE Unreal plugin docs.

### Accounts / downloads checklist

- Epic Games account (UE + MetaHuman + Quixel Bridge).
- NVIDIA Developer account (to download ACE Unreal plugin + A2F model plugins).
- Our **Cloudflare R2** creds (to pull `manifest.json` + `audio.wav`, push the
  final mp4) — reuse the existing `.env` values; no new control-plane infra.
- `ffmpeg` on the box (final audio mux).
- (If self-building the plugin for 5.7) Visual Studio 2022 / clang per UE's
  build requirements.

## 2. Build the stage, lighting, MetaHuman, and 3 Montages

1. **Stage level** — create `/Game/LAS/Maps/L_Stage`. A simple cyclorama or
   set, floor, and a **three-point lighting** rig (key + fill + rim). Save the
   lighting as the named preset the manifest references
   (`stage.lighting = "three_point_warm"`). Place (or let the script spawn) the
   MetaHuman at origin facing +X.
2. **Body Animation Montages** — author exactly **three** montages on the
   MetaHuman **body** skeleton and save them under `/Game/LAS/Anims/Montages`
   with these exact names (the manifest's `montageId` maps to them 1:1 — see
   `MONTAGE_ASSETS` in `render_from_manifest.py`):
   - `M_Explain` — open-palm explaining gesture (also covers point/count/wave/shrug/open_palms).
   - `M_LeanIn` — torso lean toward camera (covers `hand_to_chest` + `posture=leaning_in`).
   - `M_Nod` — affirmative nod (covers `nod` / `thumbs_up`).
   Source these from MetaHuman/Mixamo/Lyra sample anims retargeted to the body.
3. **Posture layer (optional polish)** — the manifest also carries `body.lean`
   and `body.yawDeg` per beat; for the POC the montages can stand alone, or add
   an additive lean pose driven by those values.

## 3. Wire ACE Audio2Face-3D to the MetaHuman face

The manifest's per-beat `face.a2fEmotion` + `intensity` are the **emotion
timeline input** to A2F; A2F produces the **facial animation** (lip-sync +
Audio2Emotion) from **our TTS audio**. Two ways to get that onto the face:

- **Bake (recommended for offline determinism):** run A2F over `audio.wav` to
  produce a single facial **AnimSequence** and save it as
  `/Game/LAS/Faces/<jobId>_Face`. The render script binds it automatically
  (`apply_face_animation`). This keeps MRQ rendering fully deterministic.
- **Plugin runtime:** drive the MetaHuman face live via the ACE A2F Blueprint
  on the MetaHuman, then record to an AnimSequence and bind it the same way.

Map A2F output to the MetaHuman ARKit face pose using NVIDIA's provided
`mh_arkit_mapping_pose_A2F` pose asset (shipped with the plugin for the current
A2F models).

## 4. Pull inputs and run the render headless

The control plane already produced and stored the inputs when the
`engine_render` job ran (`POST /api/engine-jobs`): the **performance manifest**
at R2 `work/<jobId>/manifest.json` and the **TTS audio** at the manifest's
`audio.r2Key`.

```bash
# 4a. Pull inputs from R2 (reuse existing rclone/aws creds or the control-api).
#     The manifest is also fetchable via GET /api/engine-jobs/<jobId>/manifest.
rclone copy r2:las-outputs/work/<jobId>/manifest.json ./in/
rclone copy r2:las-outputs/<audio.r2Key> ./in/audio.wav

# 4b. (If baking) run ACE Audio2Face-3D over the audio to make the face anim,
#     import it as /Game/LAS/Faces/<jobId>_Face. (Plugin tooling / A2F SDK.)

# 4c. Render headless via Movie Render Queue.
UnrealEditor-Cmd "/path/LAS.uproject" /Game/LAS/Maps/L_Stage \
  -game -RenderOffscreen -NoLoadingScreen -NoSplash -Unattended -NoTextureStreaming \
  -ExecutePythonScript="$(pwd)/services/engine/render_from_manifest.py \
      --manifest=$(pwd)/in/manifest.json \
      --audio=$(pwd)/in/audio.wav \
      --output-dir=$(pwd)/out \
      --output-name=<jobId>"
```

The script opens the stage, imports the audio, builds the Level Sequence
(audio + body montages + face bake + Cine Camera dolly per the camera cues), and
runs MRQ to 4K ProRes in `./out`.

```bash
# 4d. Mux the muxless ProRes render with the TTS audio -> final delivery mp4.
ffmpeg -i ./out/<jobId>.mov -i ./in/audio.wav \
  -map 0:v -map 1:a -c:v libx264 -crf 16 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest ./out/<jobId>.mp4

# 4e. Push back to R2 for the control plane to serve.
rclone copy ./out/<jobId>.mp4 r2:las-outputs/
```

## 5. Exit criteria (POC is "done")

- One MetaHuman on the lit `L_Stage`, lip-synced to **our** TTS audio via ACE
  Audio2Face-3D, with visible Audio2Emotion expression that tracks the manifest.
- The 3 body montages fire on the DSL beats that requested them.
- One Cine Camera dolly move plays per the manifest camera cue.
- A single **3840×2160** clip with **muxed audio** lands back in R2.

## Notes

- Optional control-plane dispatch: set `UE_RENDER_NODE_URL` (+
  `UE_RENDER_NODE_TOKEN`) on `control-api` to have `engine_render` POST
  `{ jobId, manifestKey, outputKey }` to a small agent on this box that runs
  step 4. Unset, the job still compiles + persists the manifest and parks at
  `rendering` for manual pickup — so the codeable pipeline is exercisable now.
- UE Python API names drift across versions; if a call here doesn't resolve on
  your UE build, check the in-editor **Python API reference** and adjust. The
  manifest contract does not change.
