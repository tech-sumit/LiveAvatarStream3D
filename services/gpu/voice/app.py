"""voice service: clone a voice from a sample + synthesize a script to audio.

POST /clone  -> store speaker conditioning for a voice.
POST /tts    -> render a DSL script to a single wav (with prosody + timings).
POST /smoke  -> quick clone+say smoke test (returns wav bytes).
"""

from __future__ import annotations

import json
import os
import tempfile

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

from las_common import R2Client, install_internal_auth
from synth import synth_script

app = FastAPI(title="las-voice")
# Env-gated x-internal-token check (set INTERNAL_TOKEN to enable; /health exempt).
install_internal_auth(app)

ASSETS_BUCKET = os.environ.get("R2_ASSETS_BUCKET", "las-assets")
VOICES_BUCKET = os.environ.get("R2_VOICES_BUCKET", "las-voices")
OUTPUTS_BUCKET = os.environ.get("R2_OUTPUTS_BUCKET", "las-outputs")


class CloneBody(BaseModel):
    voiceId: str
    userId: str
    sampleKey: str
    engine: str = "fish_s2"
    language: str = "en"
    outPrefix: str


class TtsBody(BaseModel):
    jobId: str
    voicePrefix: str
    engine: str = "fish_s2"
    script: dict
    outPrefix: str
    withTimings: bool = False


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "voice"}


@app.post("/clone")
def clone(body: CloneBody) -> dict:
    r2 = R2Client()
    with tempfile.TemporaryDirectory() as work:
        sample = r2.download(ASSETS_BUCKET, body.sampleKey, os.path.join(work, "sample.wav"))
        # Normalize sample to 16k mono wav for consistent conditioning.
        norm = os.path.join(work, "norm.wav")
        os.system(f'ffmpeg -y -i "{sample}" -ac 1 -ar 16000 "{norm}" >/dev/null 2>&1')
        r2.upload(norm, VOICES_BUCKET, f"{body.outPrefix}/sample.wav", "audio/wav")
        meta = {"voiceId": body.voiceId, "engine": body.engine, "language": body.language}
        r2.upload_bytes(json.dumps(meta).encode(), VOICES_BUCKET, f"{body.outPrefix}/voice.json", "application/json")
    return {"ok": True}


@app.post("/tts")
def tts(body: TtsBody) -> dict:
    r2 = R2Client()
    with tempfile.TemporaryDirectory() as work:
        sample = r2.download(VOICES_BUCKET, f"{body.voicePrefix}/sample.wav", os.path.join(work, "sample.wav"))
        out_wav = os.path.join(work, "audio.wav")
        timings, sr = synth_script(
            voice_sample_path=sample,
            engine_name=body.engine,
            script=body.script,
            out_wav=out_wav,
        )
        audio_key = f"{body.outPrefix}/audio.wav"
        timings_key = f"{body.outPrefix}/timings.json"
        r2.upload(out_wav, OUTPUTS_BUCKET, audio_key, "audio/wav")
        r2.upload_bytes(
            json.dumps([t.__dict__ for t in timings]).encode(),
            OUTPUTS_BUCKET,
            timings_key,
            "application/json",
        )
    total_s = timings[-1].end_s if timings else 0.0
    try:
        import soundfile as sf

        total_s = float(sf.info(out_wav).duration)
    except Exception:
        pass
    result: dict = {"audioKey": audio_key, "timingsKey": timings_key, "sampleRate": sr}
    if body.withTimings:
        result["durationS"] = total_s
        result["segments"] = [
            {"durationS": max(0.0, t.end_s - t.start_s)} for t in timings
        ]
    return result


class SmokeBody(BaseModel):
    voicePrefix: str
    engine: str = "fish_s2"
    text: str = "Hi, this is a quick test of my cloned voice."


@app.post("/smoke")
def smoke(body: SmokeBody) -> Response:
    r2 = R2Client()
    with tempfile.TemporaryDirectory() as work:
        sample = r2.download(VOICES_BUCKET, f"{body.voicePrefix}/sample.wav", os.path.join(work, "s.wav"))
        out_wav = os.path.join(work, "smoke.wav")
        synth_script(
            voice_sample_path=sample,
            engine_name=body.engine,
            script={"segments": [{"seq": 0, "text": body.text}]},
            out_wav=out_wav,
        )
        with open(out_wav, "rb") as f:
            return Response(content=f.read(), media_type="audio/wav")
