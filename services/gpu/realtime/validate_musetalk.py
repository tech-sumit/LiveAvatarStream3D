"""Isolated validation of the realtime MuseTalk generation path (no SFU).

Exercises the exact production code path — ``RealtimeGenerator.generate`` (XTTS-v2
streaming -> MuseTalk worker -> composited frames) — without any WebRTC, then:

  1. assembles the produced frames + 16k audio into an mp4,
  2. asserts the output is a *talking face* (lower-face motion above a floor and
     frames not black/static),
  3. optionally uploads the sample to R2 for eyeballing.

Run on the pod (system interpreter; spawns the MuseTalk venv via MUSETALK_PYTHON):

  python3 validate_musetalk.py \
      --avatar-prefix demo-user/av_xxx --voice-prefix demo-user/vo_yyy \
      --text "Hello, this is a real-time lip-sync test." \
      --out /workspace/musetalk_validation.mp4 --upload
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile

import numpy as np

from las_common import R2Client
from generate import RealtimeGenerator, AUDIO_SR


def _download_avatar(r2: R2Client, bucket: str, prefix: str, dst: str) -> tuple[str, str]:
    os.makedirs(dst, exist_ok=True)
    for i in range(8):
        try:
            r2.download(bucket, f"{prefix}/keyframes/{i:02d}.png", os.path.join(dst, f"{i:02d}.png"))
        except Exception:
            break
    idle = os.path.join(dst, "idle.mp4")
    r2.download(bucket, f"{prefix}/idle.mp4", idle)
    return dst, idle


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--avatar-prefix", required=True, help="e.g. demo-user/av_xxx")
    ap.add_argument("--voice-prefix", required=True, help="e.g. demo-user/vo_yyy")
    ap.add_argument("--avatar-id", default=None, help="defaults to last path segment of avatar-prefix")
    ap.add_argument("--text", default="Hello, this is a real time lip sync validation of the avatar.")
    ap.add_argument("--tier", default="fast")
    ap.add_argument("--out", default="/workspace/musetalk_validation.mp4")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--out-bucket", default=os.environ.get("R2_OUTPUTS_BUCKET", "las-outputs"))
    ap.add_argument("--out-key", default="validation/musetalk_realtime.mp4")
    args = ap.parse_args()

    avatars_bucket = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")
    voices_bucket = os.environ.get("R2_VOICES_BUCKET", "las-voices")
    avatar_id = args.avatar_id or args.avatar_prefix.rstrip("/").split("/")[-1]

    r2 = R2Client()
    work = tempfile.mkdtemp(prefix="musetalk_validate_")
    ref_dir, idle_path = _download_avatar(r2, avatars_bucket, args.avatar_prefix, os.path.join(work, "ref"))
    voice_sample = r2.download(voices_bucket, f"{args.voice_prefix}/sample.wav", os.path.join(work, "voice.wav"))
    print(f"[validate] idle={idle_path} voice={voice_sample} avatar_id={avatar_id}")

    gen = RealtimeGenerator(
        tier=args.tier, voice_sample_path=voice_sample, ref_dir=ref_dir,
        idle_video_path=idle_path, avatar_id=avatar_id,
    )
    print("[validate] warming (XTTS load + MuseTalk model load + avatar preparation)...")
    gen.warm()

    frames: list[np.ndarray] = []
    pcm = bytearray()
    print("[validate] generating...")
    for av in gen.generate({"text": args.text, "language": "en"}):
        if av.image_bgr is not None:
            frames.append(av.image_bgr)
        if av.pcm16:
            pcm.extend(av.pcm16)
    gen.close()

    if not frames:
        raise SystemExit("[validate] FAIL: no frames produced")
    h, w = frames[0].shape[:2]
    print(f"[validate] produced {len(frames)} frames @ {w}x{h}, {len(pcm)/2/AUDIO_SR:.2f}s audio")

    # --- sanity: talking face, not black, not static -------------------------
    arr = np.stack(frames).astype("float32")
    mean_lum = float(arr.mean())
    lower = arr[:, h // 2:, :, :]  # lower-face region carries mouth motion
    inter = float(np.abs(np.diff(lower, axis=0)).mean()) if len(frames) > 1 else 0.0
    print(f"[validate] mean_luminance={mean_lum:.1f} lower_face_interframe_delta={inter:.3f}")

    ok_black = mean_lum > 8.0
    ok_motion = inter > 0.4
    print(f"[validate] checks: not_black={ok_black} has_mouth_motion={ok_motion}")

    # --- assemble mp4 (frames + audio) ---------------------------------------
    fdir = os.path.join(work, "frames")
    os.makedirs(fdir, exist_ok=True)
    import cv2

    for i, f in enumerate(frames):
        cv2.imwrite(os.path.join(fdir, f"{i:06d}.png"), f)
    wav = os.path.join(work, "audio.wav")
    import soundfile as sf

    sf.write(wav, np.frombuffer(bytes(pcm), dtype="<i2").astype("float32") / 32768.0, AUDIO_SR)

    fps = gen.tier.target_fps
    silent = os.path.join(work, "silent.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(fps), "-i",
                    os.path.join(fdir, "%06d.png"), "-pix_fmt", "yuv420p", silent], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", silent, "-i", wav,
                    "-c:v", "copy", "-c:a", "aac", "-shortest", args.out], check=True)
    print(f"[validate] wrote {args.out} ({os.path.getsize(args.out)} bytes)")

    if args.upload:
        r2.upload(args.out, args.out_bucket, args.out_key, "video/mp4")
        print(f"[validate] uploaded -> r2://{args.out_bucket}/{args.out_key}")

    if not (ok_black and ok_motion):
        raise SystemExit("[validate] FAIL: output is black or static (not a talking face)")
    print("[validate] PASS: real lip-synced talking-head produced.")


if __name__ == "__main__":
    main()
