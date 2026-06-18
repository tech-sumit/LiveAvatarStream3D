"""Inference optimization helpers (torch.compile, fast math, warm-up, CUDA graphs).

These are best-effort: each call degrades gracefully if a feature is missing so
the same code runs on a dev box and an H100. Use at model-load time in each GPU
service to hit the latency budgets in tiers.py.
"""

from __future__ import annotations

from typing import Callable, Optional


def enable_fast_math() -> None:
    """Allow TF32 / reduced-precision matmuls (big speedup, negligible quality loss)."""
    try:
        import torch

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
    except Exception:
        pass


def compile_model(model, mode: str = "max-autotune"):
    """torch.compile with a safe fallback to the eager model."""
    try:
        import torch

        return torch.compile(model, mode=mode, fullgraph=False)
    except Exception:
        return model


def to_precision(model, precision: str):
    """Cast a model to the tier precision where the hardware supports it."""
    try:
        import torch

        if precision == "fp16":
            return model.half()
        if precision == "bf16":
            return model.to(torch.bfloat16)
        # fp8 paths are model-specific (TransformerEngine); leave as-is here.
        return model
    except Exception:
        return model


def warmup(fn: Callable, *args, iters: int = 2) -> None:
    """Run a few forward passes so CUDA graphs / autotune cache are primed."""
    try:
        import torch

        with torch.inference_mode():
            for _ in range(iters):
                fn(*args)
            torch.cuda.synchronize()
    except Exception:
        pass


class CudaGraphRunner:
    """Capture a static-shape forward pass into a CUDA graph for low jitter.

    Used by the realtime talking-head path where input shapes are fixed per
    session. Falls back to a plain call if capture is unavailable.
    """

    def __init__(self, fn: Callable):
        self._fn = fn
        self._graph = None
        self._static_in: Optional[tuple] = None
        self._static_out = None

    def __call__(self, *args):
        try:
            import torch

            if self._graph is None:
                self._static_in = args
                self._graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(self._graph):
                    self._static_out = self._fn(*self._static_in)
                return self._static_out
            for dst, src in zip(self._static_in, args):
                dst.copy_(src)
            self._graph.replay()
            return self._static_out
        except Exception:
            return self._fn(*args)
