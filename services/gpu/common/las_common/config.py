import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Runtime config for a GPU service, read from the environment (.env)."""

    control_api_url: str = os.environ.get("CONTROL_API_URL", "http://localhost:8787")
    internal_token: str = os.environ.get("INTERNAL_SERVICE_TOKEN", "change-me")

    r2_account_id: str = os.environ.get("R2_ACCOUNT_ID", "")
    r2_access_key_id: str = os.environ.get("R2_ACCESS_KEY_ID", "")
    r2_secret_access_key: str = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    r2_endpoint: str = os.environ.get("R2_ENDPOINT", "")

    director_llm_provider: str = os.environ.get("DIRECTOR_LLM_PROVIDER", "anthropic")
    director_llm_model: str = os.environ.get("DIRECTOR_LLM_MODEL", "claude-opus-4-8")
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")

    # Local cache for downloaded model weights (mounted volume in prod).
    model_cache_dir: str = os.environ.get("MODEL_CACHE_DIR", "/root/.model_cache")

    # Expressive realtime avatar (motion-state clip library). Default OFF: with
    # it unset the avatar build produces only idle.mp4 and the realtime path
    # behaves exactly as today.
    realtime_expressive: str = os.environ.get("REALTIME_EXPRESSIVE", "0")


settings = Settings()


def realtime_expressive_enabled() -> bool:
    """True when REALTIME_EXPRESSIVE opts in to the motion-state library."""
    return settings.realtime_expressive.strip().lower() in ("1", "true", "yes", "on")
