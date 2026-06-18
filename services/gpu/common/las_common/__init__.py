"""Shared helpers for the LiveAvatarStream GPU services.

Provides R2 (S3-compatible) IO, control-plane progress webhooks, and config
loaded from the environment. Kept dependency-light so each service image stays
small. The DSL / job contracts are validated against the JSON Schemas exported
from packages/protocol.
"""

from .config import Settings, settings, realtime_expressive_enabled
from .r2 import R2Client
from .webhook import ProgressReporter
from .tiers import Tier, get_tier, TIERS
from .motion_states import (
    MOTION_STATES,
    DEFAULT_CLIP,
    map_dsl_to_clip,
    manifest_path,
    write_manifest,
    read_manifest,
)
from . import optim

__all__ = [
    "Settings",
    "settings",
    "realtime_expressive_enabled",
    "R2Client",
    "ProgressReporter",
    "Tier",
    "get_tier",
    "TIERS",
    "MOTION_STATES",
    "DEFAULT_CLIP",
    "map_dsl_to_clip",
    "manifest_path",
    "write_manifest",
    "read_manifest",
    "optim",
]
