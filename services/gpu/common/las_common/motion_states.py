"""Motion-state catalog + DSL->clip mapping + manifest schema.

Shared contract used by BOTH the avatar build (which *generates* one short,
loopable expressive clip per state) and the realtime service (which *switches*
the lip-sync base clip per segment based on the director's DSL). Keeping it in
``las_common`` means both sides agree on the clip ids, the target performance of
each clip, and the on-disk manifest shape.

The catalog maps each clip id to a target ``(emotion, gesture, posture)`` taken
from the performance DSL enums in ``packages/protocol/src/dsl.ts``:

  EMOTIONS  = neutral, warm, happy, excited, serious, concerned, sad,
              confident, thoughtful, surprised
  GESTURES  = none, wave, point, open_palms, count, thumbs_up, nod, shrug,
              hand_to_chest, explain
  POSTURES  = neutral, leaning_in, upright, relaxed, turned_slightly

``map_dsl_to_clip`` collapses the full 10x10x5 DSL space down to the nearest
available clip (gesture wins when explicit, otherwise emotion decides), always
returning a valid catalog id.

Manifest JSON shape (written next to the avatar's clips on the volume):

  {
    "version": 1,
    "clips": {
      "idle": "idle.mp4",
      "listening": "listening.mp4",
      "explaining": "explaining.mp4",
      ...
    }
  }

Clip paths are stored relative to the avatar dir so the manifest stays portable
across the build host and the realtime pod (each resolves against its own avatar
dir). ``read_manifest`` returns ``{clip_id: absolute_path}`` and always includes
an ``idle`` entry, falling back to ``idle.mp4`` in the avatar dir.
"""

from __future__ import annotations

import json
import os

MANIFEST_FILENAME = "motion_manifest.json"
MANIFEST_VERSION = 1

# ~10 expressive base loops. Each value is a target (emotion, gesture, posture)
# tuple drawn from the DSL enums above; the build turns each into an
# EchoMimicV3 prompt via avatar-video/dsl_map.py. `idle` anchors the library and
# shares its framing/background with every other clip.
MOTION_STATES: dict[str, tuple[str, str, str]] = {
    "idle": ("neutral", "none", "relaxed"),
    "listening": ("neutral", "none", "leaning_in"),
    "explaining": ("neutral", "open_palms", "upright"),
    "emphatic": ("excited", "point", "leaning_in"),
    "warm_happy": ("happy", "open_palms", "neutral"),
    "serious": ("serious", "hand_to_chest", "upright"),
    "thoughtful": ("thoughtful", "hand_to_chest", "turned_slightly"),
    "greeting": ("warm", "wave", "upright"),
    "affirm": ("confident", "nod", "upright"),
    "surprised": ("surprised", "none", "upright"),
}

DEFAULT_CLIP = "explaining"

_EMOTION_TO_CLIP = {
    "happy": "warm_happy",
    "warm": "warm_happy",
    "excited": "emphatic",
    "serious": "serious",
    "concerned": "serious",
    "sad": "serious",
    "thoughtful": "thoughtful",
    "surprised": "surprised",
    "confident": "affirm",
    "neutral": "explaining",
}


def map_dsl_to_clip(emotion: str, gesture: str, posture: str) -> str:
    """Collapse a DSL ``(emotion, gesture, posture)`` to a catalog clip id.

    Gesture wins when it is explicit; otherwise emotion decides. ``posture`` is
    part of the contract but does not currently change the selection. Always
    returns a valid id from ``MOTION_STATES`` (default ``explaining``).
    """
    if gesture == "wave":
        return "greeting"
    if gesture in ("point", "count"):
        return "emphatic"
    if gesture in ("nod", "thumbs_up"):
        return "affirm"
    if gesture == "shrug":
        return "thoughtful"
    if gesture == "hand_to_chest":
        return "thoughtful" if emotion == "thoughtful" else "serious"
    if gesture in ("open_palms", "explain"):
        return "explaining"

    if gesture == "none":
        return _EMOTION_TO_CLIP.get(emotion, DEFAULT_CLIP)

    return DEFAULT_CLIP


def manifest_path(avatar_dir: str) -> str:
    """Absolute path to the motion manifest inside ``avatar_dir``."""
    return os.path.join(avatar_dir, MANIFEST_FILENAME)


def write_manifest(avatar_dir: str, mapping: dict[str, str]) -> str:
    """Write ``{clip_id: video_path}`` as the avatar's motion manifest.

    Paths are stored relative to ``avatar_dir`` when they live inside it (so the
    manifest is portable), else stored as given. An ``idle`` entry is always
    present, defaulting to ``idle.mp4``. Returns the manifest path.
    """
    clips: dict[str, str] = {}
    for clip_id, video_path in mapping.items():
        clips[clip_id] = _relativize(avatar_dir, video_path)
    clips.setdefault("idle", "idle.mp4")

    path = manifest_path(avatar_dir)
    os.makedirs(avatar_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump({"version": MANIFEST_VERSION, "clips": clips}, f, indent=2)
    return path


def read_manifest(avatar_dir: str) -> dict[str, str]:
    """Return ``{clip_id: absolute_path}`` for the avatar's motion clips.

    Relative paths are resolved against ``avatar_dir``. Always includes ``idle``
    (defaulting to ``idle.mp4`` in ``avatar_dir``); if the manifest is missing,
    returns just the idle fallback so callers degrade to today's behavior.
    """
    resolved: dict[str, str] = {}
    path = manifest_path(avatar_dir)
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        for clip_id, video_path in (data.get("clips") or {}).items():
            resolved[clip_id] = _resolve(avatar_dir, video_path)
    resolved.setdefault("idle", os.path.join(avatar_dir, "idle.mp4"))
    return resolved


def _relativize(avatar_dir: str, video_path: str) -> str:
    abs_dir = os.path.abspath(avatar_dir)
    abs_path = os.path.abspath(video_path)
    if abs_path == abs_dir or abs_path.startswith(abs_dir + os.sep):
        return os.path.relpath(abs_path, abs_dir)
    return video_path


def _resolve(avatar_dir: str, video_path: str) -> str:
    if os.path.isabs(video_path):
        return video_path
    return os.path.join(avatar_dir, video_path)
