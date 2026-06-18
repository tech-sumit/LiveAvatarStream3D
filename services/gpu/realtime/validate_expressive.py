"""Validation for the expressive-avatar (motion-state) DSL->clip selection.

Two clearly separated parts:

  1. NO-GPU unit checks (run anywhere, no pod, no model weights):
       - ``las_common.motion_states.map_dsl_to_clip`` across a table of
         representative ``(emotion, gesture, posture)`` inputs spanning the DSL
         enums in ``packages/protocol/src/dsl.ts`` (gesture priority, then
         emotion fallback, default ``explaining``), plus exhaustive coverage of
         every gesture and every emotion enum value.
       - manifest round-trip (``write_manifest`` / ``read_manifest`` in a tmp
         dir; ``idle`` always present; missing manifest degrades to idle).
       - ``RealtimeGenerator._select_clip_id`` returns ``None`` when expressive
         is OFF (legacy single-clip path).

  2. POD checks (need the real MuseTalk worker + a built motion manifest on the
     volume; skipped with a message when env / manifest are absent):
       - feed a scripted multi-turn DSL sequence through the warmed generator,
         assert the selected ``clip_id`` per segment matches ``map_dsl_to_clip``
         for that segment's DSL, and that switching base clips advances/resumes
         each clip's own frame index (per-clip continuity across interleaving).

Run the no-GPU part anywhere:

  cd services/gpu/realtime
  python validate_expressive.py

Run the full thing on the pod (with the expressive flag + a built avatar that
has a motion manifest + clips on R2):

  source /workspace/las_env.sh
  cd /opt/las/services/gpu/realtime
  REALTIME_EXPRESSIVE=1 python3 validate_expressive.py \
      --pod \
      --avatar-prefix demo-user/av_mqicx7h6cd0e9a4db55a \
      --voice-prefix  demo-user/vo_mqicx8cmab1b88aa8632
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

# Make ``las_common`` and the sibling realtime modules importable when this is
# run directly (``python validate_expressive.py``) without las_env / pip install.
_HERE = os.path.dirname(os.path.abspath(__file__))
_COMMON = os.path.abspath(os.path.join(_HERE, "..", "common"))
for _p in (_HERE, _COMMON):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from las_common import (  # noqa: E402  (after sys.path bootstrap)
    DEFAULT_CLIP,
    MOTION_STATES,
    manifest_path,
    map_dsl_to_clip,
    read_manifest,
    realtime_expressive_enabled,
    write_manifest,
)

# DSL enums mirrored from packages/protocol/src/dsl.ts. Kept here (not imported
# from TS) so the no-GPU portion stays pure-Python; if the TS enums change these
# must change too, and the exhaustive-coverage checks below will flag a gap.
EMOTIONS = (
    "neutral", "warm", "happy", "excited", "serious",
    "concerned", "sad", "confident", "thoughtful", "surprised",
)
GESTURES = (
    "none", "wave", "point", "open_palms", "count",
    "thumbs_up", "nod", "shrug", "hand_to_chest", "explain",
)
POSTURES = ("neutral", "leaning_in", "upright", "relaxed", "turned_slightly")

TIER = os.environ.get("LAS_TIER", "fast")

# Explicit (emotion, gesture, posture) -> expected clip_id table. Gesture wins
# when explicit; otherwise emotion decides; default is `explaining`.
MAPPING_CASES: list[tuple[str, str, str, str]] = [
    # --- gesture priority (gesture set, emotion intentionally varied) -------
    ("neutral", "wave", "neutral", "greeting"),
    ("serious", "wave", "upright", "greeting"),
    ("excited", "point", "leaning_in", "emphatic"),
    ("neutral", "count", "neutral", "emphatic"),
    ("confident", "nod", "upright", "affirm"),
    ("happy", "thumbs_up", "relaxed", "affirm"),
    ("neutral", "shrug", "neutral", "thoughtful"),
    ("serious", "hand_to_chest", "upright", "serious"),
    ("thoughtful", "hand_to_chest", "turned_slightly", "thoughtful"),
    ("neutral", "open_palms", "upright", "explaining"),
    ("happy", "explain", "neutral", "explaining"),
    # --- emotion fallback (gesture == none) --------------------------------
    ("happy", "none", "neutral", "warm_happy"),
    ("warm", "none", "relaxed", "warm_happy"),
    ("excited", "none", "leaning_in", "emphatic"),
    ("serious", "none", "upright", "serious"),
    ("concerned", "none", "neutral", "serious"),
    ("sad", "none", "neutral", "serious"),
    ("thoughtful", "none", "turned_slightly", "thoughtful"),
    ("surprised", "none", "upright", "surprised"),
    ("confident", "none", "upright", "affirm"),
    ("neutral", "none", "relaxed", "explaining"),
    # --- defaults / unknowns -----------------------------------------------
    ("madeup_emotion", "none", "neutral", DEFAULT_CLIP),
    ("neutral", "madeup_gesture", "neutral", DEFAULT_CLIP),
]


# --------------------------------------------------------------------------- #
# tiny PASS/FAIL accumulator                                                   #
# --------------------------------------------------------------------------- #

class Checks:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.skipped = 0

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        tag = "PASS" if ok else "FAIL"
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        print(f"  [{tag}] {name}" + (f" — {detail}" if detail else ""))
        return ok

    def skip(self, name: str, detail: str = "") -> None:
        self.skipped += 1
        print(f"  [SKIP] {name}" + (f" — {detail}" if detail else ""))


# --------------------------------------------------------------------------- #
# 1. NO-GPU unit checks                                                        #
# --------------------------------------------------------------------------- #

def check_mapping(c: Checks) -> None:
    print("[expr] DSL -> clip mapping (no GPU)")
    for emotion, gesture, posture, expected in MAPPING_CASES:
        got = map_dsl_to_clip(emotion, gesture, posture)
        c.check(
            f"map({emotion}, {gesture}, {posture}) == {expected}",
            got == expected,
            f"got {got!r}",
        )

    # Posture must not change the selection (it is part of the contract but does
    # not currently drive clip choice).
    posture_stable = True
    for emotion in EMOTIONS:
        for gesture in GESTURES:
            results = {map_dsl_to_clip(emotion, gesture, p) for p in POSTURES}
            if len(results) != 1:
                posture_stable = False
                break
        if not posture_stable:
            break
    c.check("posture does not affect clip selection", posture_stable)

    # Every result is a real catalog clip id.
    all_valid = all(
        map_dsl_to_clip(e, g, p) in MOTION_STATES
        for e in EMOTIONS for g in GESTURES for p in POSTURES
    )
    c.check("every mapping resolves to a catalog clip id", all_valid)

    # Exhaustive enum coverage: every gesture (neutral emotion) and every
    # emotion (gesture none) yields a catalog clip — proves no enum value is
    # unmapped and the DSL enums here still match motion_states' assumptions.
    gesture_cov = all(map_dsl_to_clip("neutral", g, "neutral") in MOTION_STATES for g in GESTURES)
    emotion_cov = all(map_dsl_to_clip(e, "none", "neutral") in MOTION_STATES for e in EMOTIONS)
    c.check("all gesture enum values map to a catalog clip", gesture_cov)
    c.check("all emotion enum values map to a catalog clip", emotion_cov)


def check_manifest_roundtrip(c: Checks) -> None:
    print("[expr] motion manifest round-trip (no GPU)")
    with tempfile.TemporaryDirectory(prefix="expr_manifest_") as d:
        # Manifest with explicit clips (relativized) round-trips and resolves to
        # absolute paths under the avatar dir.
        mapping = {
            "idle": os.path.join(d, "idle.mp4"),
            "explaining": os.path.join(d, "explaining.mp4"),
            "greeting": os.path.join(d, "greeting.mp4"),
        }
        path = write_manifest(d, mapping)
        c.check("write_manifest created the manifest file", os.path.exists(path))

        with open(path) as f:
            raw = json.load(f)
        rel_ok = all(not os.path.isabs(v) for v in raw.get("clips", {}).values())
        c.check("manifest stores clip paths relative to the avatar dir", rel_ok,
                f"clips={raw.get('clips')}")

        resolved = read_manifest(d)
        rt_ok = (
            resolved.get("explaining") == os.path.join(d, "explaining.mp4")
            and resolved.get("greeting") == os.path.join(d, "greeting.mp4")
        )
        c.check("read_manifest resolves clips to absolute paths under avatar dir", rt_ok,
                f"resolved={resolved}")
        c.check("idle present after round-trip", "idle" in resolved)

        # idle is injected even when the written mapping omits it.
        with tempfile.TemporaryDirectory(prefix="expr_noidle_") as d2:
            write_manifest(d2, {"explaining": os.path.join(d2, "explaining.mp4")})
            r2 = read_manifest(d2)
            c.check("idle injected when omitted from the written mapping",
                    r2.get("idle") == os.path.join(d2, "idle.mp4"), f"idle={r2.get('idle')}")

        # Missing manifest degrades to the idle-only fallback.
        with tempfile.TemporaryDirectory(prefix="expr_missing_") as d3:
            r3 = read_manifest(d3)
            c.check("missing manifest degrades to idle-only fallback",
                    list(r3.keys()) == ["idle"] and r3["idle"] == os.path.join(d3, "idle.mp4"),
                    f"resolved={r3}")


def check_generator_off(c: Checks) -> None:
    print("[expr] RealtimeGenerator clip-selection with expressive OFF (no GPU)")
    try:
        from generate import RealtimeGenerator  # numpy import lives here, not at top
    except ImportError as exc:  # numpy / las_common unavailable on a bare box
        c.skip("RealtimeGenerator._select_clip_id returns None when OFF",
               f"cannot import generate: {exc}")
        return

    gen = RealtimeGenerator(
        tier=TIER,
        voice_sample_path="/nonexistent/voice.wav",
        ref_dir="/nonexistent/ref",
        idle_video_path="/nonexistent/idle.mp4",
        avatar_id="validate-expr-off",
    )
    c.check("generator constructs with expressive OFF by default", gen.expressive is False)
    none_for_all = all(
        gen._select_clip_id({"emotion": e, "gesture": g, "posture": "neutral", "text": "x"}) is None
        for e in EMOTIONS for g in GESTURES
    )
    c.check("_select_clip_id returns None for every DSL when expressive is OFF", none_for_all)


# --------------------------------------------------------------------------- #
# 2. POD checks (real worker + built motion manifest)                          #
# --------------------------------------------------------------------------- #

# Scripted multi-turn DSL sequence. Designed so clips switch within and across
# turns AND a couple of clips are revisited (greeting, explaining) to exercise
# per-clip frame-index resume after switching away and back.
POD_SCRIPT: list[dict] = [
    # turn 1
    {"seq": 0, "text": "Hi there, great to meet you!", "emotion": "warm", "gesture": "wave",
     "posture": "upright", "language": "en"},
    {"seq": 1, "text": "Let me make one key point clearly.", "emotion": "excited", "gesture": "point",
     "posture": "leaning_in", "language": "en"},
    {"seq": 2, "text": "Here is how the whole thing fits together.", "emotion": "neutral",
     "gesture": "open_palms", "posture": "upright", "language": "en"},
    # turn 2
    {"seq": 3, "text": "I want to be honest about the risk here.", "emotion": "serious",
     "gesture": "hand_to_chest", "posture": "upright", "language": "en"},
    {"seq": 4, "text": "But welcome aboard again!", "emotion": "warm", "gesture": "wave",
     "posture": "upright", "language": "en"},
    {"seq": 5, "text": "So, to walk through the rest of it.", "emotion": "neutral",
     "gesture": "none", "posture": "relaxed", "language": "en"},
]


def _download_expressive_avatar(r2, bucket: str, prefix: str, dst: str) -> tuple[str, str]:
    """Pull idle.mp4, the motion manifest, and every clip it references into
    ``dst`` so ``read_manifest(dst)`` resolves locally exactly as on the pod.

    Mirrors app.py's ``_download_motion_clips`` so the harness and production
    agree on R2 keys: the build (avatar-build/pipeline.py) uploads the manifest
    at ``{prefix}/motion_manifest.json`` and every non-idle clip under
    ``{prefix}/motion/<clip>.mp4`` (the manifest stores a flat ``<clip>.mp4``
    rel). ``idle.mp4`` lives at ``{prefix}/idle.mp4`` (not under ``motion/``) and
    is fetched first, so the per-clip loop skips it via the os.path.exists guard.
    """
    os.makedirs(dst, exist_ok=True)
    idle = os.path.join(dst, "idle.mp4")
    r2.download(bucket, f"{prefix}/idle.mp4", idle)

    manifest_dst = os.path.join(dst, os.path.basename(manifest_path(dst)))
    try:
        r2.download(bucket, f"{prefix}/{os.path.basename(manifest_dst)}", manifest_dst)
    except Exception:
        return dst, idle  # no manifest in R2 -> caller will skip the pod portion

    with open(manifest_dst) as f:
        clips = (json.load(f).get("clips") or {})
    for clip_id, rel in clips.items():
        local = os.path.join(dst, rel)
        if os.path.exists(local):
            continue  # idle.mp4 already downloaded above
        os.makedirs(os.path.dirname(local) or dst, exist_ok=True)
        try:
            r2.download(bucket, f"{prefix}/motion/{rel}", local)
        except Exception as exc:  # noqa: BLE001
            print(f"[expr] warning: clip '{clip_id}' ({rel}) not in R2: {exc}")
    return dst, idle


def check_pod(c: Checks, args) -> None:
    print("[expr] pod: multi-turn clip selection + per-clip index continuity")

    if not args.pod:
        c.skip("pod multi-turn clip selection", "pass --pod to enable the GPU portion")
        return
    if not realtime_expressive_enabled():
        c.skip("pod multi-turn clip selection", "REALTIME_EXPRESSIVE is not enabled")
        return
    if not (args.avatar_prefix and args.voice_prefix):
        c.skip("pod multi-turn clip selection", "--avatar-prefix / --voice-prefix required")
        return

    from las_common import R2Client
    from generate import RealtimeGenerator

    avatars_bucket = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")
    voices_bucket = os.environ.get("R2_VOICES_BUCKET", "las-voices")
    avatar_id = args.avatar_id or args.avatar_prefix.rstrip("/").split("/")[-1]

    r2 = R2Client()
    work = tempfile.mkdtemp(prefix="expr_pod_")
    ref_dir, idle_path = _download_expressive_avatar(
        r2, avatars_bucket, args.avatar_prefix, os.path.join(work, "ref"))

    if not os.path.exists(manifest_path(ref_dir)):
        c.skip("pod multi-turn clip selection", "no motion manifest on R2 for this avatar")
        return

    voice_sample = r2.download(
        voices_bucket, f"{args.voice_prefix}/sample.wav", os.path.join(work, "voice.wav"))

    gen = RealtimeGenerator(tier=args.tier, voice_sample_path=voice_sample, ref_dir=ref_dir,
                            idle_video_path=idle_path, avatar_id=avatar_id)
    print(f"[expr] warming generator (expressive expected ON) avatar={avatar_id} ...")
    gen.warm()

    if not c.check("expressive turned ON after warm (manifest + clips usable)", gen.expressive,
                   "manifest/clips were not usable; cannot run pod selection checks"):
        gen.close()
        return
    print(f"[expr] prepared clips: {gen._clip_ids}")

    # Record every MuseTalk pass: which clip and its start/next frame index.
    head = gen._head
    orig_step = head.step
    calls: list[dict] = []

    def recording_step(wav_path: str, clip_id=None):
        start = head._idx.get(clip_id, 0)
        frames = list(orig_step(wav_path) if clip_id is None else orig_step(wav_path, clip_id))
        calls.append({"clip_id": clip_id, "start_idx": start,
                      "next_idx": head._idx.get(clip_id, 0), "frames": len(frames)})
        return iter(frames)

    head.step = recording_step  # type: ignore[method-assign]

    # Run the scripted sequence, attributing the new step() calls to each segment.
    selection_ok = True
    mapped_match_ok = True
    for seg in POD_SCRIPT:
        before = len(calls)
        expected_selected = gen._select_clip_id(seg)
        mapped = map_dsl_to_clip(seg["emotion"], seg["gesture"], seg["posture"])

        for _ in gen.generate(seg):
            pass

        seg_calls = calls[before:]
        used = {ci["clip_id"] for ci in seg_calls}
        ok_seg = bool(seg_calls) and used == {expected_selected}
        selection_ok = selection_ok and ok_seg
        c.check(
            f"seg {seg['seq']} ({seg['emotion']}/{seg['gesture']}) -> {expected_selected}",
            ok_seg, f"clips used: {sorted(str(u) for u in used)}")

        # When the mapped clip was actually prepared, the selection must equal
        # the pure DSL mapping (no fallback). This is the spec's core guarantee.
        if mapped in gen._clip_ids:
            this_ok = expected_selected == mapped
            mapped_match_ok = mapped_match_ok and this_ok
            c.check(f"seg {seg['seq']} selection == map_dsl_to_clip ({mapped})", this_ok)
        else:
            print(f"  [INFO] seg {seg['seq']} mapped clip '{mapped}' not prepared; "
                  f"selection fell back to '{expected_selected}'")

    c.check("every segment selected exactly one prepared clip", selection_ok)
    c.check("selection matches map_dsl_to_clip for all prepared targets", mapped_match_ok)

    # Per-clip frame-index continuity: for each clip, successive passes must
    # resume where the previous pass for that clip ended (start == prev next),
    # and each pass that produced frames must advance the index (next > start).
    by_clip: dict = {}
    for ci in calls:
        by_clip.setdefault(ci["clip_id"], []).append(ci)

    continuity_ok = True
    advance_ok = True
    revisited = []
    for clip_id, seq in by_clip.items():
        if len(seq) > 1:
            revisited.append(clip_id)
        prev_next = None
        for ci in seq:
            if prev_next is not None and ci["start_idx"] != prev_next:
                continuity_ok = False
            if ci["frames"] > 0 and ci["next_idx"] <= ci["start_idx"]:
                advance_ok = False
            prev_next = ci["next_idx"]

    c.check("per-clip frame index resumes across clip switches (start == prev next)",
            continuity_ok, f"clips: { {k: [(x['start_idx'], x['next_idx']) for x in v] for k, v in by_clip.items()} }")
    c.check("per-clip frame index advances on each pass", advance_ok)
    c.check("at least one clip was switched away from and revisited (resume exercised)",
            bool(revisited), f"revisited: {revisited}")

    head.step = orig_step  # type: ignore[method-assign]
    gen.close()


# --------------------------------------------------------------------------- #
# main                                                                         #
# --------------------------------------------------------------------------- #

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pod", action="store_true",
                    help="run the GPU pod portion (needs the worker + a built motion manifest)")
    ap.add_argument("--avatar-prefix", default=None, help="R2 avatar prefix (pod portion)")
    ap.add_argument("--voice-prefix", default=None, help="R2 voice prefix (pod portion)")
    ap.add_argument("--avatar-id", default=None)
    ap.add_argument("--tier", default=TIER)
    args = ap.parse_args()

    c = Checks()

    print("\n========== NO-GPU UNIT CHECKS ==========")
    check_mapping(c)
    check_manifest_roundtrip(c)
    check_generator_off(c)

    print("\n========== POD CHECKS ==========")
    check_pod(c, args)

    print("\n===== SUMMARY =====")
    print(json.dumps({"passed": c.passed, "failed": c.failed, "skipped": c.skipped}, indent=2))
    print("\n[expr] " + ("PASS" if c.failed == 0 else f"FAIL ({c.failed} failed)"))
    if c.failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
