"""image-gen service: FLUX/SDXL text-to-avatar (fast/casual fallback tier).

Returns a PNG stream. Model is pinned/warm after first load. FLUX.1-dev is
non-commercial; SDXL (permissive) is the default for the open posture.
"""

from __future__ import annotations

import io
import os
from functools import lru_cache

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI(title="las-image-gen")

MODEL = os.environ.get("IMAGE_GEN_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")


class GenBody(BaseModel):
    prompt: str
    negative_prompt: str = "blurry, deformed, extra limbs, watermark"
    steps: int = 30
    seed: int | None = None


@lru_cache(maxsize=1)
def _pipe():
    import torch  # lazy
    from diffusers import AutoPipelineForText2Image  # lazy
    from las_common import optim

    optim.enable_fast_math()
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL, torch_dtype=torch.float16, variant="fp16"
    ).to("cuda")
    pipe.set_progress_bar_config(disable=True)
    # Compile the UNet for steady-state throughput (warm after first call).
    pipe.unet = optim.compile_model(pipe.unet)
    return pipe


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "image-gen", "model": MODEL}


@app.post("/generate")
def generate(body: GenBody) -> Response:
    import torch

    pipe = _pipe()
    gen = torch.Generator("cuda").manual_seed(body.seed) if body.seed is not None else None
    image = pipe(
        prompt=f"{body.prompt}, photorealistic portrait, sharp focus, studio lighting",
        negative_prompt=body.negative_prompt,
        num_inference_steps=body.steps,
        generator=gen,
    ).images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")
