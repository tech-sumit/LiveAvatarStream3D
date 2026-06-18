"""Modal deployment for the GPU services (serverless H100, scale-to-zero).

Deploy:  modal deploy services/gpu/modal_app.py
This exposes one web endpoint per service; set GPU_PROVIDER_BASE_URL in the
control-plane to the deployed base and route /<service>/... to each app.

Offline services autoscale to zero; the realtime service keeps a small warm pool
(min_containers) so a session can attach inside the latency budget.
"""

from __future__ import annotations

import os

import modal

SECRET = modal.Secret.from_name("las-gpu")  # R2 + control-api token + Anthropic key
COMMON = modal.Mount.from_local_dir("services/gpu/common", remote_path="/opt/las_common")


def _image(service: str, gpu_extra: list[str] | None = None) -> modal.Image:
    req = f"services/gpu/{service}/requirements.txt"
    return (
        modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
        .apt_install("ffmpeg", "git")
        .pip_install_from_requirements(req)
        .pip_install("/opt/las_common")  # installed via the mount at build time
        .add_local_dir(f"services/gpu/{service}", remote_path="/app")
    )


app = modal.App("liveavatarstream-gpu")


def _mount_asgi(service: str, gpu: str, *, min_containers: int = 0, timeout: int = 1800):
    @app.function(
        image=_image(service),
        gpu=gpu,
        secrets=[SECRET],
        mounts=[COMMON],
        min_containers=min_containers,
        timeout=timeout,
        name=service,
    )
    @modal.asgi_app()
    def _serve():
        import sys

        sys.path.insert(0, "/app")
        from app import app as fastapi_app  # each service exposes `app`

        return fastapi_app

    return _serve


avatar_build = _mount_asgi("avatar-build", "A10G")
image_gen = _mount_asgi("image-gen", "A10G")
voice = _mount_asgi("voice", "A10G")
avatar_video = _mount_asgi("avatar-video", "H100", timeout=3600)
finishing = _mount_asgi("finishing", "H100", timeout=3600)
# Realtime keeps a warm node so sessions attach quickly.
realtime = _mount_asgi("realtime", "H100", min_containers=int(os.environ.get("REALTIME_WARM", "1")))
