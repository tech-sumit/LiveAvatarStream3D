"""
HTTP wrapper around the Audio2Face-3D NIM for the browser avatar app.

POST /a2f   body: audio/wav (16 kHz mono PCM preferred)
            resp: { "names": [...arkit...], "frames": [{ "t": s, "weights": [...] }] }

The browser (apps/avatar-live, ServerA2FClient) posts TTS/clip audio here and
applies the returned ARKit timeline to the avatar's morph targets. Point the
browser at this service with VITE_A2F_URL=http://<host>:8095/a2f.

Run:
  A2F_TARGET=localhost:52000 uvicorn app:app --host 0.0.0.0 --port 8095
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Request, Response  # type: ignore
from fastapi.middleware.cors import CORSMiddleware  # type: ignore

from a2f_client import A2FConfig, audio_to_timeline

A2F_TARGET = os.environ.get("A2F_TARGET", "localhost:52000")

app = FastAPI(title="LAS Audio2Face-3D wrapper")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev: the editor/avatar app runs on a different port
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "a2fTarget": A2F_TARGET}


@app.post("/a2f")
async def a2f(request: Request) -> Response:
    wav_bytes = await request.body()
    if not wav_bytes:
        return Response(status_code=400, content="empty audio body")
    timeline = await audio_to_timeline(wav_bytes, A2F_TARGET, A2FConfig())
    import json

    return Response(content=json.dumps(timeline), media_type="application/json")
