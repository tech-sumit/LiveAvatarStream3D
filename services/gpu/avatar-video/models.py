"""Talking-head synthesis via the real EchoMimicV3 models, tiered for quality.

EchoMimicV3 (`antgroup/echomimic_v3`, AAAI 2026) animates a single reference
image from driving audio + a text prompt, built on Wan2.1-Fun-1.3B + wav2vec2.
We shell out to the upstream repo's *real* inference entrypoints (vendored at
``TALKING_HEAD_ROOT``) rather than inventing a CLI:

  premium : EchoMimicV3-preview  -> ``echomimic_preview_infer.py`` (vendored
            single-input wrapper around the repo's preview pipeline; chunked
            long-video, face IP-mask, ~20-25 steps). Preview transformer +
            facebook/wav2vec2-base-960h.
  fast    : EchoMimicV3-Flash    -> upstream ``infer_flash.py`` (8-step, no face
            mask, Flow_Unipc). Flash transformer + chinese-wav2vec2-base.

Source verified against:
  - https://github.com/antgroup/echomimic_v3/blob/main/infer_flash.py
  - https://github.com/antgroup/echomimic_v3/blob/main/run_flash.sh
  - https://github.com/antgroup/echomimic_v3/blob/main/infer_preview.py
  - https://huggingface.co/BadToBest/EchoMimicV3 (preview + echomimicv3-flash-pro)

The interface (`synthesize`) is stable so the rest of the pipeline stays
model-agnostic. All heavy work happens in the shelled-out process; this module
imports nothing GPU-related.
"""

from __future__ import annotations

import glob
import math
import os
import shutil
import subprocess
from dataclasses import dataclass

from dsl_map import summarize_performance


@dataclass
class TalkingHeadResult:
    video_path: str  # raw model output (audio muxed; finishing re-muxes the clean track)
    fps: int


# Vendored upstream repo root (cloned onto the network volume by seed_weights.sh).
ECHOMIMIC_ROOT = os.environ.get("TALKING_HEAD_ROOT", "/workspace/repos/echomimic_v3")
# EchoMimicV3 needs a torch-2.4-compatible diffusers/transformers stack that
# conflicts with the voice service's coqui-tts (transformers>=4.57). It runs in
# an isolated venv; point the subprocess interpreter at it via ECHOMIMIC_PYTHON.
ECHOMIMIC_PYTHON = os.environ.get("ECHOMIMIC_PYTHON", "python3")
# Our single-input wrapper around the preview pipeline lives beside this module.
PREVIEW_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "echomimic_preview_infer.py")

# EchoMimicV3 renders at a fixed 25 fps; finishing assumes the same source rate.
MODEL_FPS = 25
# Cap single-render length so a long script can't OOM the H100 (≈ 60 s @ 25 fps).
MAX_FRAMES = int(os.environ.get("ECHOMIMIC_MAX_FRAMES", "1500"))


def _weights_root() -> str:
    # Weights persist on the volume; default to the repo's own `models/` dir so
    # upstream relative-path expectations and our seed layout line up.
    return os.environ.get("ECHOMIMIC_WEIGHTS_DIR", os.path.join(ECHOMIMIC_ROOT, "models"))


def _tier_config(tier: str) -> dict:
    w = _weights_root()
    wan_dir = os.environ.get("ECHOMIMIC_WAN_DIR", os.path.join(w, "Wan2.1-Fun-V1.1-1.3B-InP"))
    config_path = os.environ.get("ECHOMIMIC_CONFIG", os.path.join(ECHOMIMIC_ROOT, "config", "config.yaml"))

    if tier == "fast":
        return {
            "entrypoint": "flash",
            "model_name": wan_dir,
            "config_path": config_path,
            "transformer_path": os.environ.get(
                "ECHOMIMIC_FLASH_TRANSFORMER",
                os.path.join(w, "echomimicv3-flash-pro", "diffusion_pytorch_model.safetensors"),
            ),
            "wav2vec_dir": os.environ.get("ECHOMIMIC_FLASH_WAV2VEC", os.path.join(w, "chinese-wav2vec2-base")),
            "sampler": os.environ.get("ECHOMIMIC_FLASH_SAMPLER", "Flow_Unipc"),
            "steps": int(os.environ.get("ECHOMIMIC_FLASH_STEPS", "8")),
            "guidance_scale": float(os.environ.get("ECHOMIMIC_FLASH_GUIDANCE", "6.0")),
            "audio_guidance_scale": float(os.environ.get("ECHOMIMIC_FLASH_AUDIO_GUIDANCE", "3.0")),
            "neg_steps": int(os.environ.get("ECHOMIMIC_FLASH_NEG_STEPS", "0")),
        }

    # premium (and any unknown tier) -> highest-fidelity preview pipeline.
    return {
        "entrypoint": "preview",
        "model_name": wan_dir,
        "config_path": config_path,
        "transformer_path": os.environ.get(
            "ECHOMIMIC_PREVIEW_TRANSFORMER",
            os.path.join(w, "transformer", "diffusion_pytorch_model.safetensors"),
        ),
        "wav2vec_dir": os.environ.get("ECHOMIMIC_PREVIEW_WAV2VEC", os.path.join(w, "wav2vec2-base-960h")),
        "sampler": os.environ.get("ECHOMIMIC_PREVIEW_SAMPLER", "Flow_DPM++"),
        "steps": int(os.environ.get("ECHOMIMIC_PREVIEW_STEPS", "20")),
        "guidance_scale": float(os.environ.get("ECHOMIMIC_PREVIEW_GUIDANCE", "4.5")),
        "audio_guidance_scale": float(os.environ.get("ECHOMIMIC_PREVIEW_AUDIO_GUIDANCE", "2.5")),
        "neg_steps": int(os.environ.get("ECHOMIMIC_PREVIEW_NEG_STEPS", "2")),
    }


def _pick_reference(ref_dir: str) -> str:
    pngs = sorted(glob.glob(os.path.join(ref_dir, "*.png")))
    if not pngs:
        raise RuntimeError(f"no reference keyframes found in {ref_dir}")
    return pngs[0]


def _audio_duration_s(audio_path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip() or 0.0)


def _video_length_frames(audio_path: str) -> int:
    frames = int(math.ceil(_audio_duration_s(audio_path) * MODEL_FPS))
    return max(1, min(frames, MAX_FRAMES))


def synthesize(
    *,
    tier: str,
    ref_dir: str,
    audio_path: str,
    conditioning: list[dict],
    work_dir: str,
) -> TalkingHeadResult:
    cfg = _tier_config(tier)
    ref_image = _pick_reference(ref_dir)

    perf = summarize_performance(conditioning)
    prompt = perf["prompt"]
    # Nudge audio guidance up for more expressive performances, bounded so it
    # never leaves the model's stable range.
    audio_guidance = min(3.0, cfg["audio_guidance_scale"] + 0.5 * perf["expression_intensity"])

    save_dir = os.path.join(work_dir, "echomimic_out")
    os.makedirs(save_dir, exist_ok=True)
    video_length = _video_length_frames(audio_path)

    weight_dtype = os.environ.get("ECHOMIMIC_WEIGHT_DTYPE", "bfloat16")
    # Keep the EchoMimicV3 weights resident on the 80GB H100 instead of paying the
    # per-step host<->device shuffle of CPU offload. bfloat16 + teacache still apply.
    gpu_memory_mode = os.environ.get("ECHOMIMIC_GPU_MEMORY_MODE", "model_full_load")
    sample_size = os.environ.get("ECHOMIMIC_SAMPLE_SIZE", "768")

    if cfg["entrypoint"] == "flash":
        script = os.path.join(ECHOMIMIC_ROOT, "infer_flash.py")
    else:
        script = PREVIEW_RUNNER

    cmd = [
        ECHOMIMIC_PYTHON, script,
        "--image_path", ref_image,
        "--audio_path", audio_path,
        "--prompt", prompt,
        "--config_path", cfg["config_path"],
        "--model_name", cfg["model_name"],
        "--transformer_path", cfg["transformer_path"],
        "--wav2vec_model_dir", cfg["wav2vec_dir"],
        "--save_path", save_dir,
        "--sampler_name", cfg["sampler"],
        "--num_inference_steps", str(cfg["steps"]),
        "--guidance_scale", str(cfg["guidance_scale"]),
        "--audio_guidance_scale", str(audio_guidance),
        "--neg_steps", str(cfg["neg_steps"]),
        "--video_length", str(video_length),
        "--sample_size", sample_size, sample_size,
        "--fps", str(MODEL_FPS),
        "--weight_dtype", weight_dtype,
        "--GPU_memory_mode", gpu_memory_mode,
        "--use_dynamic_cfg",
        "--use_dynamic_acfg",
        "--enable_teacache",
    ]
    if cfg["entrypoint"] == "preview":
        cmd += ["--repo_root", ECHOMIMIC_ROOT]

    env = dict(os.environ)
    # Keep all HF / model downloads on the persistent volume cache.
    env.setdefault("HF_HOME", os.environ.get("HF_HOME", "/workspace/.model_cache"))
    env.setdefault("PYTHONPATH", ECHOMIMIC_ROOT)

    # Upstream scripts resolve `config/...` and `src` relative to the repo root.
    subprocess.run(cmd, check=True, cwd=ECHOMIMIC_ROOT, env=env)

    out_path = _locate_output(save_dir, work_dir)
    return TalkingHeadResult(video_path=out_path, fps=MODEL_FPS)


def _locate_output(save_dir: str, work_dir: str) -> str:
    # Both entrypoints write a single mp4 into save_dir (flash: <name>_output.mp4,
    # preview wrapper: <name>_audio.mp4). Pick the newest and normalise the name.
    candidates = glob.glob(os.path.join(save_dir, "*.mp4"))
    if not candidates:
        raise RuntimeError(f"EchoMimicV3 produced no mp4 in {save_dir}")
    newest = max(candidates, key=os.path.getmtime)
    raw_path = os.path.join(work_dir, "raw.mp4")
    shutil.move(newest, raw_path)
    return raw_path
