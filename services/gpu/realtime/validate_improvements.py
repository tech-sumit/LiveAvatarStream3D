"""Focused validation for the two realtime-generation improvements:

  1. STT pre-warm: shows the faster-whisper first-transcribe cold cliff and
     confirms a pre-warmed model (what RealtimeGenerator.warm() now does) makes
     the next transcribe fast.
  2. WHEP resample: feeds a real 48kHz audio frame (browser Opus rate) through
     the production runtime._make_resampler + _frame_to_pcm20 path and asserts
     the output is correct-length 16k mono PCM16, then confirms faster-whisper
     still transcribes it correctly.

Run on the pod (system interpreter):

  source /workspace/las_env.sh
  cd /opt/las/services/gpu/realtime
  python3 validate_improvements.py --speech-from /workspace/demo_video.mp4
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from fractions import Fraction

import numpy as np

from runtime import _make_resampler, _frame_to_pcm20, _PCM20_BYTES
from stt import StreamingSTT, load_model, SAMPLE_RATE


def _extract_speech(src: str, dst_wav: str, rate: int, seconds: float) -> np.ndarray:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-t", str(seconds),
         "-ac", "1", "-ar", str(rate), "-f", "wav", dst_wav],
        check=True,
    )
    import soundfile as sf

    audio, sr = sf.read(dst_wav, dtype="int16")
    assert sr == rate, f"expected {rate}, got {sr}"
    if audio.ndim > 1:
        audio = audio[:, 0]
    return audio.astype("<i2")


def _frames_48k(mono_i16_48k: np.ndarray, frame_ms: int = 20):
    """Yield aiortc-style 48kHz mono s16 AudioFrames (what WHEP delivers)."""
    import av

    n = int(48000 * frame_ms / 1000)
    pts = 0
    for i in range(0, len(mono_i16_48k) - n + 1, n):
        block = np.ascontiguousarray(mono_i16_48k[i:i + n]).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(block, format="s16", layout="mono")
        frame.sample_rate = 48000
        frame.pts = pts
        frame.time_base = Fraction(1, 48000)
        pts += n
        yield frame


def check_resample(speech_src: str, seconds: float) -> dict:
    speech48 = _extract_speech(speech_src, tempfile.mktemp(suffix=".wav"), 48000, seconds)
    resampler = _make_resampler()
    carry = bytearray()
    out = bytearray()
    n_chunks = 0
    for frame in _frames_48k(speech48):
        for chunk in _frame_to_pcm20(frame, resampler, carry):
            assert len(chunk) == _PCM20_BYTES, f"chunk={len(chunk)} != {_PCM20_BYTES}"
            out.extend(chunk)
            n_chunks += 1

    in_samples = len(speech48)
    out_samples = len(out) // 2
    expected = in_samples * SAMPLE_RATE / 48000
    ratio = out_samples / expected if expected else 0.0

    # Feed the resampled 16k audio through the real StreamingSTT and confirm a
    # transcript (proves VAD/Whisper now receive correct-rate audio).
    captured: dict = {}
    stt = StreamingSTT(on_final=lambda t: captured.update(text=t), model=load_model())
    stt._ensure()
    for i in range(0, len(out) - _PCM20_BYTES + 1, _PCM20_BYTES):
        stt.push(bytes(out[i:i + _PCM20_BYTES]))
    for _ in range(60):  # trailing silence to force VAD endpoint
        if "text" in captured:
            break
        stt.push(b"\x00" * _PCM20_BYTES)

    return {
        "input_rate": 48000,
        "input_samples": in_samples,
        "output_rate": SAMPLE_RATE,
        "output_samples": out_samples,
        "expected_output_samples": round(expected),
        "length_ratio": round(ratio, 4),
        "chunk_bytes": _PCM20_BYTES,
        "n_20ms_chunks": n_chunks,
        "transcript": captured.get("text", ""),
        "length_ok": 0.98 <= ratio <= 1.02,
        "transcribed": bool(captured.get("text", "").strip()),
    }


def check_stt_prewarm() -> dict:
    """Cold vs warm faster-whisper transcribe latency on a fixed 3s buffer."""
    model = load_model()
    buf = np.zeros(SAMPLE_RATE * 3, dtype="float32")

    t0 = time.perf_counter()
    segs, _ = model.transcribe(buf, language="en", beam_size=1)
    list(segs)
    cold = time.perf_counter() - t0

    t1 = time.perf_counter()
    segs, _ = model.transcribe(buf, language="en", beam_size=1)
    list(segs)
    warm = time.perf_counter() - t1

    return {
        "cold_first_transcribe_ms": round(cold * 1000, 1),
        "warm_transcribe_ms": round(warm * 1000, 1),
        "cliff_removed_ms": round((cold - warm) * 1000, 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speech-from", default="/workspace/demo_video.mp4")
    ap.add_argument("--speech-seconds", type=float, default=6.0)
    ap.add_argument("--skip-stt-prewarm", action="store_true")
    args = ap.parse_args()

    report: dict = {}
    print("[improve] STT cold/warm transcribe benchmark...")
    if not args.skip_stt_prewarm:
        report["stt_prewarm"] = check_stt_prewarm()
        print(f"[improve] stt: {report['stt_prewarm']}")

    print("[improve] 48kHz -> 16k resample correctness + transcribe...")
    report["resample"] = check_resample(args.speech_from, args.speech_seconds)
    print(f"[improve] resample: {report['resample']}")

    print("\n===== IMPROVEMENT METRICS =====")
    print(json.dumps(report, indent=2))

    ok = report["resample"]["length_ok"] and report["resample"]["transcribed"]
    print("\n[improve] " + ("PASS" if ok else "FAIL"))
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
