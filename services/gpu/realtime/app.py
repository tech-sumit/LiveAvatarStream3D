"""realtime service: one warm GPU node hosting live avatar sessions.

POST /sessions            -> allocate a session, connect to the SFU, start loops.
POST /sessions/{id}/dsl   -> ingest a streamed DSL segment or a barge-in cancel.
POST /sessions/stop       -> tear down a session.

The worker reconstructs R2 prefixes from ids (avatars/voices are stored at
`<userId>/<id>`), pulls the avatar keyframes + cloned voice sample, and builds a
warm RealtimeGenerator per session.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import tempfile

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from las_common import R2Client, manifest_path
from generate import RealtimeGenerator
from runtime import SessionRuntime

app = FastAPI(title="las-realtime")

AVATARS_BUCKET = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")
VOICES_BUCKET = os.environ.get("R2_VOICES_BUCKET", "las-voices")
INTERNAL_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "change-me")
CONTROL_API = os.environ.get("CONTROL_API_URL", "http://localhost:8787")
NODE_ID = os.environ.get("NODE_ID", socket.gethostname())

# Session registry + working dirs (one node hosts a few concurrent sessions).
_SESSIONS: dict[str, SessionRuntime] = {}
_WORKDIRS: dict[str, tempfile.TemporaryDirectory] = {}


class MediaInfo(BaseModel):
    """SFU connection info from the control plane. The GPU drives the SFU via
    the control-plane /rt/* routes, so it only needs ICE servers (the SFU app
    id / token live control-side; WHIP/WHEP are gone)."""

    iceServers: list[dict] = []


class StartBody(BaseModel):
    sessionId: str
    userId: str
    avatarId: str
    voiceId: str
    persona: str = ""
    tier: str = "fast"
    media: MediaInfo


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "realtime", "node": NODE_ID, "sessions": len(_SESSIONS)}


def _download_ref(r2: R2Client, prefix: str, dst: str) -> tuple[str, str]:
    """Pull the avatar profile (keyframes + idle clip) for one session.

    Returns (ref_dir, idle_video_path). The idle clip is MuseTalk's base video;
    keyframes are kept for parity with the offline plane / fallbacks. In
    expressive mode the motion manifest + its clips are also pulled (best-effort)
    so ``read_manifest``/``_resolve_expressive_clips`` find them under ``dst``.
    """
    os.makedirs(dst, exist_ok=True)
    for i in range(8):
        try:
            r2.download(AVATARS_BUCKET, f"{prefix}/keyframes/{i:02d}.png", os.path.join(dst, f"{i:02d}.png"))
        except Exception:
            break
    idle_path = os.path.join(dst, "idle.mp4")
    r2.download(AVATARS_BUCKET, f"{prefix}/idle.mp4", idle_path)
    _download_motion_clips(r2, prefix, dst)
    return dst, idle_path


def _download_motion_clips(r2: R2Client, prefix: str, dst: str) -> None:
    """Pull the motion manifest + every clip it references into ``dst`` using the
    SAME relative filenames ``read_manifest`` resolves against ``dst``.

    Mirrors validate_expressive.py's downloader. Entirely best-effort: an
    idle-only avatar (or a flag-OFF build) has no manifest in R2, so we return
    quietly and the generator degrades to the single-idle path. ``idle.mp4`` is
    already on disk from the caller and lives at ``{prefix}/idle.mp4`` (not under
    ``motion/``), so the per-clip loop skips it; the build uploads only non-idle
    clips under ``{prefix}/motion/<clip>.mp4``.
    """
    manifest_dst = os.path.join(dst, os.path.basename(manifest_path(dst)))
    try:
        r2.download(AVATARS_BUCKET, f"{prefix}/{os.path.basename(manifest_dst)}", manifest_dst)
    except Exception:
        return  # no manifest: idle-only avatar / flag-OFF build
    try:
        with open(manifest_dst) as f:
            clips = (json.load(f).get("clips") or {})
    except Exception as exc:  # noqa: BLE001
        print(f"[rt] motion manifest unreadable ({exc!r}); idle-only", flush=True)
        return
    for clip_id, rel in clips.items():
        local = os.path.join(dst, rel)
        if os.path.exists(local):
            continue  # idle.mp4 already downloaded by the caller
        os.makedirs(os.path.dirname(local) or dst, exist_ok=True)
        try:
            r2.download(AVATARS_BUCKET, f"{prefix}/motion/{rel}", local)
        except Exception as exc:  # noqa: BLE001
            print(f"[rt] motion clip {clip_id!r} ({rel}) unavailable: {exc!r}", flush=True)


@app.post("/sessions")
async def start_session(body: StartBody) -> dict:
    # Idempotent on sessionId: the control plane retries startSession on transient
    # failure, so a duplicate POST must return the existing allocation rather than
    # spawning a second MuseTalk worker / XTTS load / PC for the same session.
    # Safe without a lock: nothing below awaits before _SESSIONS is populated, so
    # the event loop can't interleave a second start between this check and the
    # registry insert.
    if body.sessionId in _SESSIONS:
        return {"node": NODE_ID}

    r2 = R2Client()
    workdir = tempfile.TemporaryDirectory()
    _WORKDIRS[body.sessionId] = workdir

    avatar_prefix = f"{body.userId}/{body.avatarId}"
    voice_prefix = f"{body.userId}/{body.voiceId}"
    ref_dir, idle_path = _download_ref(r2, avatar_prefix, os.path.join(workdir.name, "ref"))
    voice_sample = r2.download(VOICES_BUCKET, f"{voice_prefix}/sample.wav", os.path.join(workdir.name, "voice.wav"))

    generator = RealtimeGenerator(
        tier=body.tier,
        voice_sample_path=voice_sample,
        ref_dir=ref_dir,
        idle_video_path=idle_path,
        avatar_id=body.avatarId,
        engine=os.environ.get("REALTIME_TTS", "xtts_v2"),
    )
    runtime = SessionRuntime(body.sessionId, body.dict(), generator)
    # Auto-release on WebRTC transport death (closed tab / network drop / crash):
    # the runtime watches both PeerConnections and calls this to tear down AND
    # drop the app-level registry entry, exactly as the HTTP stop path does, so a
    # vanished browser can't leak the session + GPU memory on the single node.
    runtime.on_release = lambda sid=body.sessionId: _release_session(sid)
    _SESSIONS[body.sessionId] = runtime
    # The control plane registers the session -> SessionDO mapping only AFTER
    # this POST /sessions response returns (it awaits the allocation call inside
    # SessionDO.start, then stores the mapping). The avatar publish is itself a
    # /rt/* callback into the control plane, so it must run after we return —
    # otherwise /rt/publish 404s on a not-yet-mapped session. Warm + connect in
    # the background; the browser's subscribe 425-retries until the publish lands.
    asyncio.create_task(_run_session(runtime, body))
    return {"node": NODE_ID}


async def _run_session(runtime: SessionRuntime, body: StartBody) -> None:
    try:
        await runtime.start(
            control_api_base=CONTROL_API,
            session_id=body.sessionId,
            ice_servers=body.media.iceServers,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[rt {body.sessionId}] start failed: {exc!r}", flush=True)
        # warm() may already have spawned the MuseTalk worker subprocess + loaded
        # XTTS, and _publish() may have opened a PeerConnection, before start()
        # raised. stop() closes both PCs, cancels any legs, and shuts the worker
        # (gen.close()) so a failed start doesn't leak a subprocess / GPU memory.
        try:
            await runtime.stop()
        except Exception as stop_exc:  # noqa: BLE001
            print(f"[rt {body.sessionId}] cleanup after failed start: {stop_exc!r}", flush=True)
        _SESSIONS.pop(body.sessionId, None)
        wd = _WORKDIRS.pop(body.sessionId, None)
        if wd is not None:
            wd.cleanup()


@app.post("/sessions/{session_id}/dsl")
async def ingest_dsl(session_id: str, body: dict, x_internal_token: str = Header(default="")) -> dict:
    if x_internal_token != INTERNAL_TOKEN:
        raise HTTPException(status_code=403, detail="forbidden")
    runtime = _SESSIONS.get(session_id)
    if not runtime:
        raise HTTPException(status_code=404, detail="no such session")
    await runtime.ingest(body)
    return {"ok": True}


class StopBody(BaseModel):
    node: str | None = None
    sessionId: str | None = None


@app.post("/sessions/stop")
async def stop_session(body: StopBody) -> dict:
    if body.sessionId and body.sessionId in _SESSIONS:
        await _release_session(body.sessionId)
        return {"ok": True}
    # Stop-by-node: tear down everything on this node.
    for sid in list(_SESSIONS):
        await _release_session(sid)
    return {"ok": True}


async def _release_session(session_id: str) -> None:
    """Single teardown path shared by the HTTP stop route and the runtime's
    transport-death auto-release: pop the registry entry (so /health sessions
    drops), stop the runtime (idempotent — releases the MuseTalk worker + GPU
    memory), and drop the working dir. Pop-first makes a racing duplicate (e.g.
    both PCs failing) a no-op."""
    runtime = _SESSIONS.pop(session_id, None)
    if runtime is not None:
        await runtime.stop()
    _cleanup_workdir(session_id)


def _cleanup_workdir(session_id: str) -> None:
    wd = _WORKDIRS.pop(session_id, None)
    if wd is not None:
        wd.cleanup()
