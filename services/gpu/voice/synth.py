"""Script -> single audio track, applying DSL prosody (emphasis + pauses).

Produces a mono wav plus per-segment timing so the talking-head stage can align
gestures/expressions to speech.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass

from engines import get_engine


@dataclass
class SegmentTiming:
    seq: int
    start_s: float
    end_s: float
    emotion: str
    gesture: str
    posture: str


def _apply_emphasis(text: str, emphasis: list[str]) -> str:
    # Lightweight prosody: wrap emphasized words so capable engines stress them.
    out = text
    for w in emphasis:
        if w and w in out:
            out = out.replace(w, f"*{w}*")
    return out


def synth_script(*, voice_sample_path: str, engine_name: str, script: dict, out_wav: str, lang: str = "en"):
    import numpy as np
    import soundfile as sf

    engine = get_engine(engine_name)
    cond = engine.clone(voice_sample_path)
    sr = engine.sample_rate

    pieces: list = []
    timings: list[SegmentTiming] = []
    cursor = 0.0

    for seg in sorted(script["segments"], key=lambda s: s.get("seq", 0)):
        text = _apply_emphasis(seg["text"], seg.get("emphasis", []))
        audio, seg_sr = engine.synth(text, cond, seg.get("language", lang) if isinstance(seg, dict) else lang)
        if seg_sr != sr:
            audio = _resample(audio, seg_sr, sr)
        start = cursor
        pieces.append(audio)
        cursor += len(audio) / sr

        pause = seg.get("pause_ms_after", 0) / 1000.0
        if pause > 0:
            pieces.append(np.zeros(int(pause * sr), dtype="float32"))
            cursor += pause

        timings.append(
            SegmentTiming(
                seq=seg.get("seq", 0),
                start_s=start,
                end_s=start + len(audio) / sr,
                emotion=seg.get("emotion", "neutral"),
                gesture=seg.get("gesture", "none"),
                posture=seg.get("posture", "neutral"),
            )
        )

    track = np.concatenate(pieces) if pieces else np.zeros(1, dtype="float32")
    track = track / (max(1e-6, float(abs(track).max())))  # normalize
    sf.write(out_wav, track, sr)
    return timings, sr


def _resample(audio, src_sr: int, dst_sr: int):
    import numpy as np

    if src_sr == dst_sr:
        return audio
    duration = len(audio) / src_sr
    n = int(duration * dst_sr)
    xp = np.linspace(0, 1, len(audio))
    x = np.linspace(0, 1, n)
    return np.interp(x, xp, audio).astype("float32")
