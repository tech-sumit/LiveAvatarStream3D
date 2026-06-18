from __future__ import annotations

from typing import Optional

from .config import settings


class ProgressReporter:
    """Posts JobProgressWebhook events back to the control plane.

    Authenticated with the shared INTERNAL_SERVICE_TOKEN (no user auth yet).
    Matches packages/protocol JobProgressWebhook.
    """

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def report(
        self,
        status: str,
        progress: Optional[float] = None,
        message: Optional[str] = None,
        output_key: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        import httpx  # lazy

        body = {"jobId": self.job_id, "status": status}
        if progress is not None:
            body["progress"] = progress
        if message is not None:
            body["message"] = message
        if output_key is not None:
            body["outputKey"] = output_key
        if error is not None:
            body["error"] = error

        try:
            httpx.post(
                f"{settings.control_api_url}/api/internal/jobs/progress",
                json=body,
                headers={"authorization": f"Bearer {settings.internal_token}"},
                timeout=10.0,
            )
        except Exception:
            # Progress reporting is best-effort; never crash the pipeline on it.
            pass
