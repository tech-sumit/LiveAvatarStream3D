"""avatar-video service: talking-head synthesis (offline premium + fast tiers).

POST /render: reference avatar + cloned-voice audio + DSL conditioning ->
raw talking-head video (pre-finishing). A premium EchoMimicV3 render runs for
minutes, well past the RunPod proxy's ~100s request ceiling, so /render mirrors
the finishing service: it accepts the job, returns 202 immediately, and renders
on a background thread. On success it chains directly to the finishing service
over localhost (NOT through the proxy) so the heavy finish stage also runs off
the request path; finishing then drives the job to its terminal state over the
progress webhook. On failure the render thread reports 'failed' itself.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from las_common import R2Client, ProgressReporter
from dsl_map import build_conditioning
from models import synthesize

app = FastAPI(title="las-avatar-video")

AVATARS_BUCKET = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")
OUTPUTS_BUCKET = os.environ.get("R2_OUTPUTS_BUCKET", "las-outputs")

# Pod-internal address of the finishing service (supervisord binds it on 8005).
# Reaching it over localhost keeps the finish off the proxied request path.
FINISHING_URL = os.environ.get("FINISHING_URL", "http://127.0.0.1:8005")


class RenderBody(BaseModel):
    jobId: str
    avatarPrefix: str
    audioKey: str
    script: dict
    tier: str = "premium"
    outPrefix: str
    fps: int = 30
    outputKey: str


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "avatar-video"}


def _download_ref(r2: R2Client, prefix: str, dst: str) -> str:
    """Pull avatar keyframes (and idle clip if present) into a local dir."""
    os.makedirs(dst, exist_ok=True)
    # Keyframes are stored 00..NN; fetch what exists.
    for i in range(8):
        key = f"{prefix}/keyframes/{i:02d}.png"
        try:
            r2.download(AVATARS_BUCKET, key, os.path.join(dst, f"{i:02d}.png"))
        except Exception:
            break
    return dst


def _dispatch_finish(body: RenderBody, video_key: str) -> None:
    """Hand the raw clip to the finishing service over localhost (unproxied)."""
    httpx.post(
        f"{FINISHING_URL}/finish",
        json={
            "jobId": body.jobId,
            "videoKey": video_key,
            "audioKey": body.audioKey,
            "fps": body.fps,
            "outputKey": body.outputKey,
        },
        timeout=30.0,
    )


def _run_render(body: RenderBody) -> None:
    reporter = ProgressReporter(body.jobId)
    try:
        r2 = R2Client()
        with tempfile.TemporaryDirectory() as work:
            ref_dir = _download_ref(r2, body.avatarPrefix, os.path.join(work, "ref"))
            audio = r2.download(OUTPUTS_BUCKET, body.audioKey, os.path.join(work, "audio.wav"))

            # Timings come from the voice stage (same outPrefix).
            timings = []
            try:
                tk = r2.download(OUTPUTS_BUCKET, f"{body.outPrefix}/timings.json", os.path.join(work, "t.json"))
                with open(tk) as f:
                    timings = json.load(f)
            except Exception:
                timings = [
                    {"start_s": 0, "end_s": 1, "seq": s.get("seq", 0),
                     "emotion": s.get("emotion", "neutral"),
                     "gesture": s.get("gesture", "none"), "posture": s.get("posture", "neutral")}
                    for s in body.script.get("segments", [])
                ]

            # The voice-stage timings don't carry `emphasis`; join it back from the
            # script by seq so the DSL->prompt mapping can use it.
            emphasis_by_seq = {
                s.get("seq", 0): s.get("emphasis", []) for s in body.script.get("segments", [])
            }
            for t in timings:
                t.setdefault("emphasis", emphasis_by_seq.get(t.get("seq", 0), []))

            reporter.report("talking_head", progress=0.45, message=f"Synthesizing ({body.tier})")
            conditioning = build_conditioning(timings)
            result = synthesize(
                tier=body.tier,
                ref_dir=ref_dir,
                audio_path=audio,
                conditioning=conditioning,
                work_dir=work,
            )

            video_key = f"{body.outPrefix}/raw.mp4"
            r2.upload(result.video_path, OUTPUTS_BUCKET, video_key, "video/mp4")

        # Chain straight into finishing over localhost. /finish is itself 202 +
        # background thread, so this returns fast; finishing owns the terminal
        # 'succeeded'/'failed' webhook from here.
        _dispatch_finish(body, video_key)
    except Exception as e:  # noqa: BLE001 - surface any failure back to the control plane
        reporter.report("failed", error=f"render failed: {e}")


@app.post("/render")
def render(body: RenderBody) -> JSONResponse:
    threading.Thread(target=_run_render, args=(body,), daemon=True).start()
    return JSONResponse(
        status_code=202,
        content={"accepted": True, "jobId": body.jobId, "outputKey": body.outputKey},
    )
