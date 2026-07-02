"""Reference-video -> AvatarProfile pipeline.

Steps: decode video -> detect + crop face -> quality checks -> ArcFace identity
embedding -> pick keyframes + extract an idle-motion clip -> (optional) LoRA
fine-tune. Outputs are written to the AVATARS bucket under `out_prefix`.

Model deps (insightface, torch) load lazily so the module imports cleanly in
CI / unit-test environments without a GPU.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, asdict
from typing import Optional

from las_common import (
    R2Client,
    MOTION_STATES,
    manifest_path,
    write_manifest,
    realtime_expressive_enabled,
)

ASSETS_BUCKET = os.environ.get("R2_ASSETS_BUCKET", "las-assets")
AVATARS_BUCKET = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")

# Per-avatar clip library lives on the persistent volume so the realtime worker
# can MuseTalk-preprocess + cache each clip exactly as it does idle.mp4 today.
AVATAR_WORKSPACE_ROOT = os.environ.get("LAS_AVATAR_WORKSPACE", "/workspace/avatars")
# Each motion-state loop is a short, silent, loopable segment.
MOTION_STATE_SECONDS = float(os.environ.get("MOTION_STATE_SECONDS", "5"))

# Quality gates for a usable reference video.
MIN_DURATION_S = 8.0
MIN_FACE_FRAMES_RATIO = 0.6  # share of sampled frames that must contain one clear face
MIN_FACE_PX = 160


@dataclass
class BuildResult:
    identity_dim: Optional[int]
    has_lora: bool
    ref_duration_s: Optional[float]


class QualityError(RuntimeError):
    pass


def _probe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip() or 0.0)


def _sample_frames(path: str, dst_dir: str, fps: float = 2.0) -> list[str]:
    os.makedirs(dst_dir, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-i", path, "-vf", f"fps={fps}", os.path.join(dst_dir, "f_%04d.png")],
        capture_output=True, check=True,
    )
    return sorted(os.path.join(dst_dir, f) for f in os.listdir(dst_dir) if f.endswith(".png"))


def _face_analyzer():
    from insightface.app import FaceAnalysis  # lazy

    # insightface ignores INSIGHTFACE_HOME and reads `root` (default ~/.insightface).
    # Point it at the persistent volume so buffalo_l is reused, not re-downloaded.
    root = os.environ.get("INSIGHTFACE_HOME") or os.path.expanduser("~/.insightface")
    app = FaceAnalysis(name="buffalo_l", root=root)
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def build_profile(
    *,
    avatar_id: str,
    user_id: str,
    source_type: str,
    source_key: str,
    out_prefix: str,
    prompt: Optional[str] = None,
    tier: str = "premium",
    fine_tune: bool = False,
    build_motion_states: bool = False,
    r2: Optional[R2Client] = None,
) -> BuildResult:
    r2 = r2 or R2Client()
    # Generate the expressive clip library when explicitly requested OR when the
    # REALTIME_EXPRESSIVE flag is on. Off by default -> idle-only build.
    want_motion = build_motion_states or realtime_expressive_enabled()

    with tempfile.TemporaryDirectory() as work:
        if source_type == "reference_video":
            src = r2.download(ASSETS_BUCKET, source_key, os.path.join(work, "ref.mp4"))
            return _build_from_video(avatar_id, src, out_prefix, work, tier, fine_tune, want_motion, r2)

        if source_type == "image_upload":
            src = r2.download(ASSETS_BUCKET, source_key, os.path.join(work, "ref.png"))
            return _build_from_image(src, out_prefix, work, r2)

        if source_type == "generated":
            img = _generate_still(prompt or "a professional portrait, neutral background", work)
            return _build_from_image(img, out_prefix, work, r2)

        raise QualityError(f"unknown source_type {source_type}")


def _build_from_video(avatar_id, video_path, out_prefix, work, tier, fine_tune, build_motion_states, r2) -> BuildResult:
    import cv2  # lazy
    import numpy as np  # lazy

    duration = _probe_duration(video_path)
    if duration < MIN_DURATION_S:
        raise QualityError(f"reference video too short ({duration:.1f}s < {MIN_DURATION_S}s)")

    frames = _sample_frames(video_path, os.path.join(work, "frames"))
    analyzer = _face_analyzer()

    embeddings = []
    keyframes = []
    good = 0
    for fp in frames:
        img = cv2.imread(fp)
        faces = analyzer.get(img)
        if len(faces) != 1:
            continue
        f = faces[0]
        x1, y1, x2, y2 = f.bbox.astype(int)
        if min(x2 - x1, y2 - y1) < MIN_FACE_PX:
            continue
        good += 1
        embeddings.append(f.normed_embedding)
        if len(keyframes) < 8:
            crop = img[max(0, y1):y2, max(0, x1):x2]
            kf_path = os.path.join(work, f"kf_{len(keyframes)}.png")
            cv2.imwrite(kf_path, crop)
            keyframes.append(kf_path)

    if not frames or good / len(frames) < MIN_FACE_FRAMES_RATIO:
        raise QualityError("not enough frames with a single clear, well-lit face")

    identity = np.mean(np.stack(embeddings), axis=0)
    identity = identity / (np.linalg.norm(identity) + 1e-9)

    # Idle-motion clip: a short, low-talking segment used to fill realtime gaps.
    idle_path = os.path.join(work, "idle.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-t", "4", "-an", "-vf", "scale=512:-2", idle_path],
        capture_output=True, check=True,
    )

    has_lora = bool(fine_tune) and _maybe_fine_tune(keyframes, work, out_prefix, r2)

    # Persist outputs to R2.
    profile = {
        "avatarId": avatar_id,
        "sourceType": "reference_video",
        "tier": tier,
        "identityDim": int(identity.shape[0]),
        "hasLora": has_lora,
        "refDurationS": duration,
        "keyframeCount": len(keyframes),
    }
    r2.upload_bytes(identity.astype("float32").tobytes(), AVATARS_BUCKET, f"{out_prefix}/identity.bin", "application/octet-stream")
    r2.upload(idle_path, AVATARS_BUCKET, f"{out_prefix}/idle.mp4", "video/mp4")
    for i, kf in enumerate(keyframes):
        r2.upload(kf, AVATARS_BUCKET, f"{out_prefix}/keyframes/{i:02d}.png", "image/png")
    r2.upload_bytes(json.dumps(profile).encode(), AVATARS_BUCKET, f"{out_prefix}/profile.json", "application/json")

    if build_motion_states:
        _build_motion_states(
            avatar_id=avatar_id,
            idle_path=idle_path,
            ref_dir=work,
            out_prefix=out_prefix,
            work=work,
            tier=tier,
            r2=r2,
        )

    return BuildResult(identity_dim=int(identity.shape[0]), has_lora=has_lora, ref_duration_s=duration)


def _build_from_image(image_path, out_prefix, work, r2) -> BuildResult:
    import cv2

    analyzer = _face_analyzer()
    img = cv2.imread(image_path)
    faces = analyzer.get(img)
    if len(faces) != 1:
        raise QualityError("image must contain exactly one clear face")
    identity = faces[0].normed_embedding

    profile = {
        "sourceType": "image",
        "tier": "fast",
        "identityDim": int(identity.shape[0]),
        "hasLora": False,
    }
    r2.upload(image_path, AVATARS_BUCKET, f"{out_prefix}/keyframes/00.png", "image/png")
    r2.upload_bytes(identity.astype("float32").tobytes(), AVATARS_BUCKET, f"{out_prefix}/identity.bin", "application/octet-stream")
    r2.upload_bytes(json.dumps(profile).encode(), AVATARS_BUCKET, f"{out_prefix}/profile.json", "application/json")
    return BuildResult(identity_dim=int(identity.shape[0]), has_lora=False, ref_duration_s=None)


def _generate_still(prompt: str, work: str) -> str:
    """Fast fallback tier: produce an avatar still via the image-gen service."""
    import httpx

    base = os.environ.get("IMAGE_GEN_URL", "http://localhost:8001")
    out = os.path.join(work, "gen.png")
    # image-gen enforces the same x-internal-token gate as this service (las_common.auth);
    # this GPU→GPU sibling call must present the shared token or every 'generated'-source
    # build 401s the moment INTERNAL_TOKEN hardening is enabled.
    token = os.environ.get("INTERNAL_TOKEN", "")
    headers = {"x-internal-token": token} if token else {}
    with httpx.stream(
        "POST", f"{base}/generate", json={"prompt": prompt}, headers=headers, timeout=120.0
    ) as resp:
        resp.raise_for_status()
        with open(out, "wb") as f:
            for chunk in resp.iter_bytes():
                f.write(chunk)
    return out


def _avatar_workspace_dir(avatar_id: str) -> str:
    return os.path.join(AVATAR_WORKSPACE_ROOT, avatar_id)


def _load_avatar_video():
    """Import avatar-video's dsl_map + models from the sibling service dir.

    Lazy + sys.path-based on purpose: like the cv2/insightface imports above,
    the EchoMimicV3 stack must not load at module import (keeps CI clean and the
    avatar-video deps out of the default idle-only build).
    """
    avatar_video_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "avatar-video"
    )
    if avatar_video_dir not in sys.path:
        sys.path.insert(0, avatar_video_dir)
    import dsl_map  # cross-service, GPU-adjacent: see docstring
    import models  # cross-service, GPU-adjacent: see docstring

    return dsl_map, models


def _silent_drive_wav(work: str, seconds: float, sr: int = 16000) -> str:
    """A short silent wav to drive EchoMimicV3 for a non-speaking expressive loop.

    Lip motion comes from audio; with silence the mouth stays mostly closed and
    the prompt + reference steer the gesture/posture/expression.
    """
    out = os.path.join(work, "motion_drive.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=mono",
         "-t", f"{seconds}", out],
        capture_output=True, check=True,
    )
    return out


def _probe_dimensions(path: str) -> tuple[int, int]:
    """Return (width, height) of a video's first video stream via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=s=x:p=0", path],
        capture_output=True, text=True, check=True,
    )
    w_str, h_str = out.stdout.strip().split("x")
    return int(w_str), int(h_str)


def _match_idle_framing(src: str, dst: str, width: int, height: int) -> None:
    """Normalise a generated clip to idle.mp4's EXACT WxH (silent).

    EchoMimicV3 renders square (e.g. 768x768) while idle.mp4 keeps the source
    aspect (e.g. 512x288), so a bare ``scale=512:-2`` left motion clips at
    512x512 — a different resolution from idle. Fitting every clip into idle's
    exact box (preserve aspect, then pad) means all prepared clips + ambient
    cycles share one resolution: no on-switch reframe, and the crossfade
    shape-guard passes.
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-an", "-vf", vf, dst],
        capture_output=True, check=True,
    )


def _build_motion_states(*, avatar_id, idle_path, ref_dir, out_prefix, work, tier, r2) -> None:
    """Optional expressive step: one short loopable clip per non-idle motion state.

    For each catalog state, builds an EchoMimicV3 prompt via avatar-video's
    dsl_map and renders a clip from the avatar reference with the SAME invocation
    as avatar-video/models.py, normalises it to the idle framing, writes it to
    the avatar dir on the volume + R2, and records a manifest. The default
    idle.mp4 build is untouched; this only runs when expressive is on.
    """
    dsl_map, models = _load_avatar_video()

    avatar_dir = _avatar_workspace_dir(avatar_id)
    os.makedirs(avatar_dir, exist_ok=True)

    # idle anchors the library; co-locate it so the manifest's idle entry
    # resolves and every clip shares its framing/background.
    local_idle = os.path.join(avatar_dir, "idle.mp4")
    if os.path.abspath(idle_path) != os.path.abspath(local_idle):
        shutil.copyfile(idle_path, local_idle)

    # Every motion clip is normalised to idle.mp4's exact resolution so the whole
    # library (idle + clips + ambient cycles) shares one WxH.
    idle_w, idle_h = _probe_dimensions(local_idle)

    drive_wav = _silent_drive_wav(work, MOTION_STATE_SECONDS)

    mapping = {"idle": local_idle}
    for clip_id, (emotion, gesture, posture) in MOTION_STATES.items():
        if clip_id == "idle":
            continue
        clip_work = os.path.join(work, f"motion_{clip_id}")
        os.makedirs(clip_work, exist_ok=True)
        conditioning = dsl_map.build_conditioning([{
            "seq": 0,
            "start_s": 0.0,
            "end_s": MOTION_STATE_SECONDS,
            "emotion": emotion,
            "gesture": gesture,
            "posture": posture,
            "emphasis": [],
        }])
        result = models.synthesize(
            tier=tier,
            ref_dir=ref_dir,
            audio_path=drive_wav,
            conditioning=conditioning,
            work_dir=clip_work,
        )
        clip_path = os.path.join(avatar_dir, f"{clip_id}.mp4")
        _match_idle_framing(result.video_path, clip_path, idle_w, idle_h)
        mapping[clip_id] = clip_path
        r2.upload(clip_path, AVATARS_BUCKET, f"{out_prefix}/motion/{clip_id}.mp4", "video/mp4")

    write_manifest(avatar_dir, mapping)
    r2.upload(
        manifest_path(avatar_dir),
        AVATARS_BUCKET,
        f"{out_prefix}/{os.path.basename(manifest_path(avatar_dir))}",
        "application/json",
    )


def _maybe_fine_tune(keyframes, work, out_prefix, r2) -> bool:
    """Per-avatar LoRA fine-tune (premium realism). Stubbed trainer call.

    In production this kicks a LoRA/adapter trainer on the keyframes + crops and
    uploads `lora.safetensors`. It is intentionally guarded so the base build
    never fails because of fine-tune issues.
    """
    try:
        from trainer import train_lora  # provided in the prod image
    except Exception:
        return False
    try:
        lora_path = train_lora(keyframes, work)
        r2.upload(lora_path, AVATARS_BUCKET, f"{out_prefix}/lora.safetensors", "application/octet-stream")
        return True
    except Exception:
        return False
