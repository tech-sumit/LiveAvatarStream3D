"""Quality/speed tier definitions shared across GPU services.

A tier pins the backend model, numeric precision, target fps, and the latency
budget the realtime path must respect. The control plane passes `tier` through;
each service reads its slice here so defaults stay consistent.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Tier:
    name: str
    talking_head_backend: str
    tts_engine: str
    precision: str          # fp16 | fp8 | bf16
    target_fps: int
    use_trt: bool           # TensorRT engine vs eager
    use_rife: bool          # frame interpolation in finishing
    # Steady-state motion-to-photon budget for the realtime media path (ms).
    realtime_budget_ms: int


TIERS: dict[str, Tier] = {
    # Max fidelity, offline only. RIFE + TensorRT FP16.
    "premium": Tier(
        name="premium",
        talking_head_backend="omniavatar",
        tts_engine="fish_s2",
        precision="fp16",
        target_fps=30,
        use_trt=True,
        use_rife=True,
        realtime_budget_ms=0,
    ),
    # Realtime-capable. FP8 where supported, streaming TTS, no RIFE.
    "fast": Tier(
        name="fast",
        talking_head_backend="liveportrait",
        tts_engine="cosyvoice2",
        precision="fp8",
        target_fps=25,
        use_trt=True,
        use_rife=False,
        realtime_budget_ms=150,
    ),
}


def get_tier(name: str) -> Tier:
    return TIERS.get(name, TIERS["premium"])
