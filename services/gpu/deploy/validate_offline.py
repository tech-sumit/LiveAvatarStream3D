"""End-to-end validation of the OFFLINE render path through the deployed control plane.

Drives the *exact* production HTTP surface of the `las-control-api` Worker — the
same calls the web app makes — to prove the offline MVP end to end:

  upload demo_video.mp4 -> build avatar "Urwashi" -> clone voice ->
  POST /api/jobs (voice/tts -> avatar-video/render -> finishing) ->
  download the finished mp4 and assert it is a real 1920x1080 video.

Nothing here is faked: the Worker dispatches real GPU work on the H100 pod and
this script only succeeds if a genuine mp4 of the expected resolution lands in
R2 and streams back out of `GET /api/jobs/:id/download`.

Prerequisites (a live system — this is not a dry run):
  * A running H100 pod with the GPU plane up (see services/gpu/deploy/POD_SETUP.md)
    and weights seeded; the pod gateway reachable at GPU_PROVIDER_BASE_URL.
  * The Worker deployed with GPU_PROVIDER_BASE_URL + GPU_PROVIDER_TOKEN +
    INTERNAL_SERVICE_TOKEN set (see services/control-api/wrangler.toml).
  * `ffmpeg`/`ffprobe` on PATH (used to extract a voice sample and probe output).

Run (from the repo root, against the deployed Worker):

  CONTROL_API_URL=https://las-control-api.<acct>.workers.dev \\
  python3 services/gpu/deploy/validate_offline.py \\
      --video demo_video.mp4 --out /tmp/urwashi_offline.mp4

Local dev Worker (`wrangler dev`) works too:

  python3 services/gpu/deploy/validate_offline.py --api http://localhost:8787

The script is patient by design — premium EchoMimicV3 + finishing can take
several minutes — and prints every state transition so a stall is obvious.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

USER_ID = "demo-user"
AVATAR_LABEL = "Urwashi"
EXPECTED_W = 1920
EXPECTED_H = 1080


def _req(method: str, url: str, *, body: bytes | None = None, headers: dict | None = None,
         timeout: float = 120.0) -> tuple[int, bytes]:
    hdrs = dict(headers or {})
    # Cloudflare's edge bot-check (error 1010) rejects the default Python-urllib
    # User-Agent on workers.dev; present a browser-like UA so requests pass.
    hdrs.setdefault("User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post_json(api: str, path: str, payload: dict) -> dict:
    status, raw = _req("POST", f"{api}{path}", body=json.dumps(payload).encode(),
                       headers={"content-type": "application/json"})
    if status >= 300:
        raise SystemExit(f"[validate] FAIL: POST {path} -> {status}: {raw.decode(errors='replace')}")
    return json.loads(raw or b"{}")


def _get_json(api: str, path: str) -> dict:
    status, raw = _req("GET", f"{api}{path}")
    if status >= 300:
        raise SystemExit(f"[validate] FAIL: GET {path} -> {status}: {raw.decode(errors='replace')}")
    return json.loads(raw or b"{}")


def _upload(api: str, kind: str, file_path: str, content_type: str) -> str:
    """Mint an upload target, PUT the bytes through the Worker, return the R2 key."""
    target = _post_json(api, "/api/uploads", {"userId": USER_ID, "kind": kind, "contentType": content_type})
    with open(file_path, "rb") as f:
        data = f.read()
    status, raw = _req("PUT", target["url"], body=data,
                       headers={"content-type": content_type}, timeout=300.0)
    if status >= 300:
        raise SystemExit(f"[validate] FAIL: upload PUT -> {status}: {raw.decode(errors='replace')}")
    print(f"[validate] uploaded {kind} ({len(data)} bytes) -> {target['key']}")
    return target["key"]


def _extract_voice_sample(video: str, dst: str, seconds: float) -> str:
    """Pull a clean mono voice sample out of the reference video for cloning."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video, "-t", str(seconds),
         "-vn", "-ac", "1", "-ar", "22050", dst],
        check=True,
    )
    if not os.path.getsize(dst):
        raise SystemExit("[validate] FAIL: extracted voice sample is empty (no audio track?)")
    return dst


def _poll(label: str, fn, *, ok: str, fail: str, timeout_s: float, interval_s: float = 6.0) -> dict:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        state = fn()
        status = state.get("status")
        if status != last:
            print(f"[validate] {label}: {status}")
            last = status
        if status == ok:
            return state
        if status == fail:
            raise SystemExit(f"[validate] FAIL: {label} -> {fail}: {state.get('error') or state}")
        time.sleep(interval_s)
    raise SystemExit(f"[validate] FAIL: {label} timed out after {timeout_s:.0f}s (last status={last})")


def _avatar_status(api: str, avatar_id: str) -> dict:
    for av in _get_json(api, f"/api/avatars?userId={USER_ID}"):
        if av.get("id") == avatar_id:
            return av
    return {"status": "missing"}


def _voice_status(api: str, voice_id: str) -> dict:
    for vo in _get_json(api, f"/api/voices?userId={USER_ID}"):
        if vo.get("id") == voice_id:
            return vo
    return {"status": "missing"}


def _job_status(api: str, job_id: str) -> dict:
    return _get_json(api, f"/api/jobs/{job_id}").get("job", {})


def _probe_dimensions(path: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path],
        capture_output=True, text=True, check=True,
    )
    w, h = out.stdout.strip().split("x")
    return int(w), int(h)


def _default_script() -> dict:
    return {
        "version": 1,
        "language": "en",
        "segments": [
            {
                "seq": 0,
                "text": "Hi, I'm Urwashi. This is an end to end offline render straight from my reference video.",
                "emotion": "warm",
                "gesture": "open_palms",
                "posture": "upright",
                "emphasis": ["Urwashi", "offline"],
                "pause_ms_after": 300,
            },
            {
                "seq": 1,
                "text": "Voice cloning, talking head synthesis, and the finishing chain all ran on the GPU plane.",
                "emotion": "confident",
                "gesture": "explain",
                "posture": "leaning_in",
                "emphasis": ["GPU plane"],
                "pause_ms_after": 0,
            },
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Offline 1080p render e2e validation (avatar 'Urwashi').")
    ap.add_argument("--api", default=os.environ.get("CONTROL_API_URL"),
                    help="control-api base URL (defaults to $CONTROL_API_URL)")
    ap.add_argument("--video", default="demo_video.mp4", help="reference video for avatar + voice")
    ap.add_argument("--out", default="/tmp/urwashi_offline.mp4", help="where to save the finished mp4")
    ap.add_argument("--tier", default="premium", choices=["fast", "premium"])
    ap.add_argument("--engine", default="fish_s2",
                    help="TTS engine (fish_s2 falls back to XTTS-v2 if Fish S2 not served)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--voice-sample-seconds", type=float, default=25.0)
    ap.add_argument("--script-file", default=None, help="JSON file with a DSL Script; default uses a built-in one")
    ap.add_argument("--avatar-timeout", type=float, default=900.0)
    ap.add_argument("--voice-timeout", type=float, default=600.0)
    ap.add_argument("--render-timeout", type=float, default=1200.0)
    args = ap.parse_args()

    if not args.api:
        raise SystemExit("[validate] FAIL: set --api or CONTROL_API_URL to the deployed Worker URL")
    api = args.api.rstrip("/")
    if not os.path.isfile(args.video):
        raise SystemExit(f"[validate] FAIL: reference video not found: {args.video}")

    print(f"[validate] control-api = {api}")
    health = _get_json(api, "/api/health")
    print(f"[validate] control-api health: {health}")

    script = json.load(open(args.script_file)) if args.script_file else _default_script()

    # 1) Build avatar "Urwashi" from the reference video.
    ref_key = _upload(api, "reference_video", args.video, "video/mp4")
    avatar = _post_json(api, "/api/avatars", {
        "userId": USER_ID, "label": AVATAR_LABEL, "sourceType": "reference_video",
        "sourceKey": ref_key, "tier": args.tier, "fineTune": False,
    })
    avatar_id = avatar["id"]
    print(f"[validate] building avatar '{AVATAR_LABEL}' id={avatar_id}")
    _poll("avatar-build", lambda: _avatar_status(api, avatar_id),
          ok="ready", fail="failed", timeout_s=args.avatar_timeout)

    # 2) Clone a voice from a sample extracted from the same reference video.
    sample_path = _extract_voice_sample(args.video, "/tmp/urwashi_voice_sample.wav", args.voice_sample_seconds)
    sample_key = _upload(api, "voice_sample", sample_path, "audio/wav")
    voice = _post_json(api, "/api/voices", {
        "userId": USER_ID, "label": f"{AVATAR_LABEL} voice",
        "sampleKey": sample_key, "engine": args.engine, "language": "en",
    })
    voice_id = voice["id"]
    print(f"[validate] cloning voice id={voice_id} engine={args.engine}")
    _poll("voice-clone", lambda: _voice_status(api, voice_id),
          ok="ready", fail="failed", timeout_s=args.voice_timeout)

    # 3) Offline render: voice/tts -> avatar-video/render -> finishing -> R2.
    job = _post_json(api, "/api/jobs", {
        "userId": USER_ID,
        "spec": {"avatarId": avatar_id, "voiceId": voice_id, "script": script,
                 "tier": args.tier, "fps": args.fps},
    })
    job_id = job["id"]
    print(f"[validate] render job id={job_id}")
    _poll("offline-render", lambda: _job_status(api, job_id),
          ok="succeeded", fail="failed", timeout_s=args.render_timeout)

    # 4) Download the finished mp4 and assert it is a real 1080p video.
    status, raw = _req("GET", f"{api}/api/jobs/{job_id}/download", timeout=300.0)
    if status >= 300:
        raise SystemExit(f"[validate] FAIL: download -> {status}: {raw.decode(errors='replace')}")
    with open(args.out, "wb") as f:
        f.write(raw)
    size = os.path.getsize(args.out)
    if size < 10_000:
        raise SystemExit(f"[validate] FAIL: output mp4 suspiciously small ({size} bytes)")
    w, h = _probe_dimensions(args.out)
    print(f"[validate] downloaded {args.out} ({size} bytes) @ {w}x{h}")
    if (w, h) != (EXPECTED_W, EXPECTED_H):
        raise SystemExit(f"[validate] FAIL: expected {EXPECTED_W}x{EXPECTED_H}, got {w}x{h}")

    print(f"[validate] PASS: real {EXPECTED_W}x{EXPECTED_H} offline render of '{AVATAR_LABEL}' produced "
          f"(avatar={avatar_id} voice={voice_id} job={job_id}).")


if __name__ == "__main__":
    main()
