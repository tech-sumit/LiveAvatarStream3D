"""avatar-build service: reference video -> AvatarProfile (+ optional LoRA).

Invoked by the control plane (POST /build). Heavy work runs synchronously and
returns the profile metadata; the control plane flips the avatar to `ready`.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from pipeline import build_profile, BuildResult, QualityError

app = FastAPI(title="las-avatar-build")


class BuildBody(BaseModel):
    avatarId: str
    userId: str
    sourceType: str
    sourceKey: str
    outPrefix: str
    prompt: str | None = None
    tier: str = "premium"
    fineTune: bool = False
    buildMotionStates: bool = False


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "avatar-build"}


@app.post("/build")
def build(body: BuildBody) -> dict:
    try:
        res: BuildResult = build_profile(
            avatar_id=body.avatarId,
            user_id=body.userId,
            source_type=body.sourceType,
            source_key=body.sourceKey,
            out_prefix=body.outPrefix,
            prompt=body.prompt,
            tier=body.tier,
            fine_tune=body.fineTune,
            build_motion_states=body.buildMotionStates,
        )
    except QualityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {
        "identityDim": res.identity_dim,
        "hasLora": res.has_lora,
        "refDurationS": res.ref_duration_s,
    }
