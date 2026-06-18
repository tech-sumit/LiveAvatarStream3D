"""finishing service: raw talking-head video -> finished 1080p mp4 in R2.

The finish runs on every rendered frame (restore + super-res + RIFE) and routinely
exceeds the RunPod proxy's ~100s request ceiling, so /finish accepts the job and
returns 202 immediately, then does the work on a background thread and drives the
job to its terminal state over the progress webhook (succeeded with outputKey, or
failed). The orchestrator dispatches this fire-and-forget and lets the webhook
finalize the job; it never blocks awaiting the finish.
"""

from __future__ import annotations

import os
import tempfile
import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from las_common import R2Client, ProgressReporter
from pipeline import finish

app = FastAPI(title="las-finishing")

OUTPUTS_BUCKET = os.environ.get("R2_OUTPUTS_BUCKET", "las-outputs")


class FinishBody(BaseModel):
    jobId: str
    videoKey: str
    audioKey: str
    fps: int = 30
    outputKey: str


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "finishing"}


def _run_finish(body: FinishBody) -> None:
    reporter = ProgressReporter(body.jobId)
    try:
        r2 = R2Client()
        with tempfile.TemporaryDirectory() as work:
            raw = r2.download(OUTPUTS_BUCKET, body.videoKey, os.path.join(work, "raw.mp4"))
            audio = r2.download(OUTPUTS_BUCKET, body.audioKey, os.path.join(work, "audio.wav"))
            out = os.path.join(work, "final.mp4")

            reporter.report("finishing", progress=0.85, message="Restore + super-res + interpolate")
            finish(raw_video=raw, audio=audio, target_fps=body.fps, out_mp4=out, profile="offline")

            r2.upload(out, OUTPUTS_BUCKET, body.outputKey, "video/mp4")
            reporter.report("succeeded", progress=1.0, message="Finished", output_key=body.outputKey)
    except Exception as e:  # noqa: BLE001 - report any failure back to the control plane
        reporter.report("failed", error=f"finishing failed: {e}")


@app.post("/finish")
def do_finish(body: FinishBody) -> JSONResponse:
    threading.Thread(target=_run_finish, args=(body,), daemon=True).start()
    return JSONResponse(
        status_code=202,
        content={"accepted": True, "jobId": body.jobId, "outputKey": body.outputKey},
    )
