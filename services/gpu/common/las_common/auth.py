"""Internal-token auth for the GPU FastAPI services.

The control plane (services/control-api src/gpu/provider.ts) sends
``x-internal-token: <INTERNAL_SERVICE_TOKEN>`` on every dispatch. When the
``INTERNAL_TOKEN`` env var is set on a pod, every route except ``/health``
requires that header to match (constant-time compare). When it is unset the
service stays open (backwards-compatible POC posture) but logs a warning once.

FastAPI is imported lazily so las_common stays importable in non-service
contexts (scripts, tests) without the fastapi dependency.
"""

from __future__ import annotations

import hmac
import logging
import os

logger = logging.getLogger("las.internal_auth")

# Must mirror the header name HttpGpuProvider sends (provider.ts).
INTERNAL_TOKEN_HEADER = "x-internal-token"

_EXEMPT_PATHS = frozenset({"/health"})
_warned_open = False


def install_internal_auth(app) -> None:
    """Install the x-internal-token gate on a FastAPI app (exempts /health)."""
    from fastapi import Request  # lazy — see module docstring
    from fastapi.responses import JSONResponse

    @app.middleware("http")
    async def _require_internal_token(request: Request, call_next):
        global _warned_open
        expected = os.environ.get("INTERNAL_TOKEN", "")
        if not expected:
            if not _warned_open:
                _warned_open = True
                logger.warning(
                    "INTERNAL_TOKEN is not set — accepting unauthenticated requests. "
                    "Set INTERNAL_TOKEN (same value as the control plane's "
                    "INTERNAL_SERVICE_TOKEN secret) to require the %s header.",
                    INTERNAL_TOKEN_HEADER,
                )
            return await call_next(request)
        if request.url.path in _EXEMPT_PATHS:
            return await call_next(request)
        presented = request.headers.get(INTERNAL_TOKEN_HEADER, "")
        if not hmac.compare_digest(presented, expected):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)
