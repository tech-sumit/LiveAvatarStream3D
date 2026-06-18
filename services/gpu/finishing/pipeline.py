"""Finishing chain: raw model frames -> 1080p mp4.

GPU-resident, single-pass pipeline:

  NVDEC decode (ffmpeg -hwaccel cuda) -> in-memory frames -> per-frame GFPGAN
  face restore -> *batched* Real-ESRGAN super-res -> resize to 1920x1080 ->
  in-process RIFE frame interpolation (GPU, exact target fps) -> ONE x264 encode
  + audio mux.

No PNG round-trips, no intermediate mp4s, and exactly one libx264 encode. RIFE
runs in-process (no shelling out to inference_video.py, which depends on a
numpy-incompatible skvideo) so finishing no longer silently degrades to CPU
ffmpeg minterpolate. A lighter `realtime` profile skips interpolation.

Model deps load lazily so the module imports without a GPU.
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
from functools import lru_cache

import numpy as np

TARGET_H = 1080
TARGET_W = 1920

# EchoMimicV3 renders at 25 fps; we probe the raw clip but fall back to this.
DEFAULT_SRC_FPS = 25

# Practical-RIFE checkout. Default matches start.sh's MODELS_DIR layout so RIFE
# resolves on the persistent volume without depending on the /opt/models symlink
# (the container disk, and thus that symlink, is wiped on every pod resume).
RIFE_DIR = os.environ.get("RIFE_DIR", "/workspace/models/Practical-RIFE")

# Frames per Real-ESRGAN batch. All frames share a resolution, so the upscaler
# runs one GPU call per batch instead of idling on Python/IO between frames.
RESTORE_BATCH = int(os.environ.get("FINISH_RESTORE_BATCH", "4"))


@lru_cache(maxsize=1)
def _tune_backends():
    """Autotune conv kernels for our fixed frame sizes; quality-neutral."""
    import torch

    torch.backends.cudnn.benchmark = True
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    return True


@lru_cache(maxsize=1)
def _restorer():
    from gfpgan import GFPGANer  # lazy

    model_path = os.environ.get("GFPGAN_MODEL", "/opt/models/GFPGANv1.4.pth")
    # upscale=1: GFPGAN restores the face at native resolution and Real-ESRGAN
    # does the actual upscaling (higher quality than GFPGAN's cv2 background
    # resize) — and it keeps the ESRGAN input small.
    return GFPGANer(model_path=model_path, upscale=1, arch="clean", channel_multiplier=2)


@lru_cache(maxsize=1)
def _upsampler():
    import torch
    from realesrgan import RealESRGANer  # lazy
    from basicsr.archs.rrdbnet_arch import RRDBNet

    _tune_backends()
    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    up = RealESRGANer(
        scale=4,
        model_path=os.environ.get("REALESRGAN_MODEL", "/opt/models/RealESRGAN_x4plus.pth"),
        model=model,
        half=True,
    )
    # channels_last is markedly faster for these convs on H100 (Hopper).
    up.model = up.model.to(memory_format=torch.channels_last)
    return up


@lru_cache(maxsize=1)
def _rife_model():
    """Load Practical-RIFE in-process (GPU). Raises loudly if weights are absent."""
    import torch

    weights = os.path.join(RIFE_DIR, "train_log", "flownet.pkl")
    if not os.path.isfile(weights):
        raise RuntimeError(f"RIFE weights missing: {weights}")
    if RIFE_DIR not in sys.path:
        sys.path.insert(0, RIFE_DIR)
    from train_log.RIFE_HDv3 import Model  # type: ignore

    model = Model()
    # rank=-1 strips the DDP "module." prefix the checkpoint was saved with.
    model.load_model(os.path.join(RIFE_DIR, "train_log"), -1)
    model.eval()
    model.device()
    if not torch.cuda.is_available():
        raise RuntimeError("RIFE requires CUDA but torch.cuda.is_available() is False")
    return model


def _probe_fps(video: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", video],
        capture_output=True, text=True, check=True,
    )
    raw = out.stdout.strip()
    try:
        num, _, den = raw.partition("/")
        fps = float(num) / float(den) if den else float(num)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    return fps if fps > 0 else float(DEFAULT_SRC_FPS)


def _probe_dims(video: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", video],
        capture_output=True, text=True, check=True,
    )
    w, h = out.stdout.strip().split("x")
    return int(w), int(h)


def _decode_frames(video: str, w: int, h: int) -> list[np.ndarray]:
    """NVDEC-decode the clip straight to BGR frames in memory (no PNG on disk).

    Hardware decode (-hwaccel cuda) is supported on the H100 even though hardware
    *encode* is not; the decoded frames are piped as raw bgr24 to this process.
    """
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-hwaccel", "cuda",
         "-i", video, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    framesize = w * h * 3
    frames: list[np.ndarray] = []
    assert proc.stdout is not None
    while True:
        buf = proc.stdout.read(framesize)
        if len(buf) < framesize:
            break
        frames.append(np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy())
    proc.stdout.close()
    proc.wait()
    if not frames:
        raise RuntimeError(f"NVDEC decode produced no frames from {video}")
    return frames


def _esrgan_to_1080p(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Real-ESRGAN x4 + downscale to 1080p for a batch of equal-size BGR frames.

    The x4 output (e.g. 3072x3072 fp16) is kept on the GPU and antialias-downscaled
    to 1920x1080 there, so only small 1080p uint8 frames cross back to host memory
    instead of a ~110MB fp32 tensor per frame. Area resampling is high-quality for
    downscaling (no ringing) — quality-neutral vs a host-side Lanczos pass.
    """
    import torch
    import torch.nn.functional as F

    up = _upsampler()
    device = up.device
    pre_pad = up.pre_pad

    rgb = [f[:, :, ::-1].astype(np.float32) / 255.0 for f in frames]
    batch = np.stack([np.transpose(r, (2, 0, 1)) for r in rgb], axis=0)
    t = torch.from_numpy(np.ascontiguousarray(batch)).to(device)
    if up.half:
        t = t.half()
    if pre_pad:
        t = F.pad(t, (0, pre_pad, 0, pre_pad), "reflect")
    t = t.to(memory_format=torch.channels_last)
    with torch.no_grad():
        out = up.model(t)
        if pre_pad:
            out = out[:, :, : out.shape[2] - pre_pad * up.scale, : out.shape[3] - pre_pad * up.scale]
        out = F.interpolate(out.float(), size=(TARGET_H, TARGET_W), mode="area").clamp_(0, 1)
        out = out.mul_(255.0).round_().byte()[:, [2, 1, 0], :, :]  # RGB -> BGR
        out = out.permute(0, 2, 3, 1).contiguous().cpu().numpy()
    return [out[i] for i in range(out.shape[0])]


def _restore_and_upscale(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Per-frame GFPGAN face restore + batched Real-ESRGAN super-res to 1080p."""
    restorer = _restorer()
    out: list[np.ndarray] = []
    for start in range(0, len(frames), RESTORE_BATCH):
        chunk = frames[start:start + RESTORE_BATCH]
        restored = []
        for img in chunk:
            _, _, r = restorer.enhance(img, has_aligned=False, only_center_face=False, paste_back=True)
            restored.append(r)
        out.extend(_esrgan_to_1080p(restored))
    return out


def _rife_pair(model, f0: np.ndarray, f1: np.ndarray, timestep: float) -> np.ndarray:
    """Interpolate one frame at `timestep` in (0,1) between two BGR 1080p frames."""
    import torch
    import torch.nn.functional as F

    h, w, _ = f0.shape
    t0 = torch.from_numpy(np.ascontiguousarray(np.transpose(f0, (2, 0, 1)))).to("cuda").float().div_(255.0).unsqueeze(0)
    t1 = torch.from_numpy(np.ascontiguousarray(np.transpose(f1, (2, 0, 1)))).to("cuda").float().div_(255.0).unsqueeze(0)
    tmp = 128
    ph = ((h - 1) // tmp + 1) * tmp
    pw = ((w - 1) // tmp + 1) * tmp
    pad = (0, pw - w, 0, ph - h)
    t0p, t1p = F.pad(t0, pad), F.pad(t1, pad)
    with torch.no_grad():
        mid = model.inference(t0p, t1p, timestep, 1.0)
    mid = mid[:, :, :h, :w].squeeze(0).clamp_(0, 1).mul_(255.0).byte().cpu().numpy()
    return np.transpose(mid, (1, 2, 0))


def _encode(frames_iter, n_frames: int, audio: str, fps: int, out_mp4: str) -> None:
    """Single libx264 encode: raw BGR frames in -> 1080p mp4 + AAC audio out.

    Software x264 (not NVENC): the H100 (Hopper) has no hardware video-encode
    ASIC, so h264_nvenc fails to open even though ffmpeg lists it. CRF 16 +
    preset medium keeps quality high in the one and only recompression.
    """
    proc = subprocess.Popen(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{TARGET_W}x{TARGET_H}", "-r", f"{fps}", "-i", "pipe:0",
            "-i", audio,
            "-c:v", "libx264", "-preset", "medium", "-crf", "16",
            "-pix_fmt", "yuv420p", "-threads", "0",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest", "-movflags", "+faststart",
            out_mp4,
        ],
        stdin=subprocess.PIPE,
    )
    assert proc.stdin is not None
    written = 0
    for frame in frames_iter:
        proc.stdin.write(frame.tobytes())
        written += 1
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError(f"x264 encode failed (wrote {written}/{n_frames} frames)")


def _interpolated_stream(hi: list[np.ndarray], src_fps: float, target_fps: int):
    """Yield exactly `round(duration*target_fps)` 1080p frames.

    For each output index k, map to source position p = k * src_fps/target_fps and
    interpolate the exact fractional frame with one RIFE call (or reuse a source
    frame when the fraction is ~0). This hits the target rate directly — no
    2x-then-resample over-interpolation.
    """
    n_src = len(hi)
    if n_src == 1:
        yield hi[0]
        return
    model = _rife_model()
    n_out = max(1, int(round(n_src / src_fps * target_fps)))
    step = src_fps / target_fps
    for k in range(n_out):
        p = k * step
        i0 = int(math.floor(p))
        frac = p - i0
        if i0 >= n_src - 1:
            yield hi[-1]
        elif frac < 1e-3:
            yield hi[i0]
        elif frac > 1 - 1e-3:
            yield hi[i0 + 1]
        else:
            yield _rife_pair(model, hi[i0], hi[i0 + 1], frac)


def finish(*, raw_video: str, audio: str, target_fps: int, out_mp4: str, profile: str = "offline") -> str:
    import time

    t0 = time.time()
    src_fps = _probe_fps(raw_video)
    w, h = _probe_dims(raw_video)
    raw_frames = _decode_frames(raw_video, w, h)
    n_in = len(raw_frames)
    hi = _restore_and_upscale(raw_frames)
    del raw_frames

    if profile == "offline" and target_fps > src_fps and len(hi) > 1:
        out_fps = target_fps
        n_out = max(1, int(round(len(hi) / src_fps * target_fps)))
        _encode(_interpolated_stream(hi, src_fps, target_fps), n_out, audio, out_fps, out_mp4)
    else:
        out_fps = int(round(src_fps))
        n_out = len(hi)
        _encode(iter(hi), len(hi), audio, out_fps, out_mp4)

    dt = time.time() - t0
    print(f"[finishing] {n_in} in / {n_out} out frames in {dt:.1f}s "
          f"({n_in / dt:.2f} in-fps, {n_out / dt:.2f} out-fps) "
          f"src={w}x{h}@{src_fps:.0f} -> {TARGET_W}x{TARGET_H}@{out_fps}", flush=True)
    return out_mp4
