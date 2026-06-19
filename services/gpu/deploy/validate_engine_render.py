"""End-to-end validation of the 3D engine_render path (Three.js on H100 pod).

  voice clone (or reuse) -> POST /api/engine-jobs -> engine-three render -> mp4 in R2

Prerequisites: H100 pod with engine-three on :8090 via nginx /engine-three/, control-api deployed.

  CONTROL_API_URL=https://las-control-api.<acct>.workers.dev \\
  python3 services/gpu/deploy/validate_engine_render.py \\
      --video demo_video.mp4 --out /tmp/engine_poc.mp4
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
EXPECTED_W = 1920
EXPECTED_H = 1080


def _req(method: str, url: str, *, body: bytes | None = None, headers: dict | None = None,
         timeout: float = 120.0) -> tuple[int, bytes]:
    hdrs = dict(headers or {})
    hdrs.setdefault(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    )
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post_json(api: str, path: str, payload: dict) -> dict:
    status, raw = _req(
        "POST",
        f"{api}{path}",
        body=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    if status >= 300:
        raise SystemExit(f"[validate-engine] FAIL: POST {path} -> {status}: {raw.decode(errors='replace')}")
    return json.loads(raw or b"{}")


def _get_json(api: str, path: str) -> dict:
    status, raw = _req("GET", f"{api}{path}")
    if status >= 300:
        raise SystemExit(f"[validate-engine] FAIL: GET {path} -> {status}: {raw.decode(errors='replace')}")
    return json.loads(raw or b"{}")


def _upload(api: str, kind: str, file_path: str, content_type: str) -> str:
    target = _post_json(api, "/api/uploads", {"userId": USER_ID, "kind": kind, "contentType": content_type})
    with open(file_path, "rb") as f:
        data = f.read()
    status, raw = _req(
        "PUT",
        target["url"],
        body=data,
        headers={"content-type": content_type},
        timeout=300.0,
    )
    if status >= 300:
        raise SystemExit(f"[validate-engine] FAIL: upload -> {status}")
    return target["key"]


def _extract_voice_sample(video: str, dst: str, seconds: float) -> str:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", video, "-t", str(seconds), "-vn", "-ac", "1", "-ar", "22050", dst],
        check=True,
    )
    return dst


def _poll(fn, *, ok: str, fail: str, timeout_s: float, interval_s: float = 8.0) -> dict:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        state = fn()
        status = state.get("status")
        if status != last:
            print(f"[validate-engine] job: {status}")
            last = status
        if status == ok:
            return state
        if status == fail:
            raise SystemExit(f"[validate-engine] FAIL: {state.get('error') or state}")
        time.sleep(interval_s)
    raise SystemExit(f"[validate-engine] FAIL: timed out (last={last})")


def _voice_status(api: str, voice_id: str) -> dict:
    for vo in _get_json(api, f"/api/voices?userId={USER_ID}"):
        if vo.get("id") == voice_id:
            return vo
    return {"status": "missing"}


def _job(api: str, job_id: str) -> dict:
    return _get_json(api, f"/api/jobs/{job_id}").get("job", {})


def _probe(path: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path],
        capture_output=True,
        text=True,
        check=True,
    )
    w, h = out.stdout.strip().split("x")
    return int(w), int(h)


def _default_script() -> dict:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    fixture = os.path.join(root, "engine-three", "assets", "fixtures", "poc_script.json")
    if os.path.isfile(fixture):
        return json.load(open(fixture))
    return {
        "version": 1,
        "language": "en",
        "segments": [
            {
                "seq": 0,
                "text": "Hello from the Three.js engine path.",
                "emotion": "warm",
                "gesture": "wave",
                "posture": "leaning_in",
                "camera": {"shot": "medium_close", "move": "dolly_in", "target": "face"},
            }
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="3D engine_render e2e validation")
    ap.add_argument("--api", default=os.environ.get("CONTROL_API_URL"))
    ap.add_argument("--video", default="demo_video.mp4")
    ap.add_argument("--out", default="/tmp/engine_poc.mp4")
    ap.add_argument("--engine", default="xtts_v2")
    ap.add_argument("--render-timeout", type=float, default=900.0)
    ap.add_argument("--script-file", default=None)
    args = ap.parse_args()

    if not args.api:
        raise SystemExit("[validate-engine] set --api or CONTROL_API_URL")
    api = args.api.rstrip("/")
    script = json.load(open(args.script_file)) if args.script_file else _default_script()

    if os.path.isfile(args.video):
        sample = _extract_voice_sample(args.video, "/tmp/engine_voice.wav", 20.0)
        sample_key = _upload(api, "voice_sample", sample, "audio/wav")
        voice = _post_json(
            api,
            "/api/voices",
            {"userId": USER_ID, "label": "engine poc", "sampleKey": sample_key, "engine": args.engine, "language": "en"},
        )
        voice_id = voice["id"]
        _poll(lambda: _voice_status(api, voice_id), ok="ready", fail="failed", timeout_s=600.0)
    else:
        voices = _get_json(api, f"/api/voices?userId={USER_ID}")
        if not voices:
            raise SystemExit(
                "[validate-engine] no voices and no --video; provide demo_video.mp4 for voice clone"
            )
        voice_id = voices[0]["id"]
        print(f"[validate-engine] WARNING: reusing voice {voice_id} — pass --video for a fresh clone")

    job = _post_json(
        api,
        "/api/engine-jobs",
        {
            "userId": USER_ID,
            "spec": {
                "avatarId": "ada",
                "voiceId": voice_id,
                "script": script,
                "fps": 24,
                "resolution": {"width": 1920, "height": 1080},
                "stage": {"level": "studio", "lighting": "three_point_warm"},
            },
        },
    )
    job_id = job["id"]
    print(f"[validate-engine] engine_render job={job_id}")
    _poll(lambda: _job(api, job_id), ok="succeeded", fail="failed", timeout_s=args.render_timeout)

    status, raw = _req("GET", f"{api}/api/jobs/{job_id}/download", timeout=300.0)
    if status >= 300:
        raise SystemExit(f"[validate-engine] download failed {status}")
    with open(args.out, "wb") as f:
        f.write(raw)
    w, h = _probe(args.out)
    print(f"[validate-engine] {args.out} @ {w}x{h}")
    if w < 1280 or h < 720:
        raise SystemExit(f"[validate-engine] FAIL: resolution too small {w}x{h}")
    print(f"[validate-engine] PASS job={job_id}")


if __name__ == "__main__":
    main()
