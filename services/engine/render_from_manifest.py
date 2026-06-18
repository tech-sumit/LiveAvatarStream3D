"""
render_from_manifest.py — UE5 Movie Render Queue driver for the LiveAvatarStream
3D-engine cinematic POC.

  ┌──────────────────────────────────────────────────────────────────────┐
  │  THIS SCRIPT RUNS INSIDE UNREAL ENGINE 5.7, NOT IN THIS REPO'S NODE/   │
  │  PYTHON ENV. It imports `unreal`, which only exists in the UE editor   │
  │  Python runtime. It is BEST-EFFORT and UNTESTED here because this      │
  │  environment has no Unreal Engine, no MetaHuman, and no RTX/display    │
  │  GPU. See services/engine/POC_SETUP.md for how to run it on an RTX/    │
  │  L40S workstation or cloud node.                                       │
  └──────────────────────────────────────────────────────────────────────┘

What it does, given a PerformanceManifest (the control-plane hand-off contract,
see packages/protocol/src/manifest.ts) plus the rendered TTS audio:

  1. Open the stage level and find/spawn the MetaHuman.
  2. Import the TTS audio as a SoundWave.
  3. Build a Level Sequence:
       - master Audio track bound to the SoundWave at t=0,
       - a Skeletal Animation track on the MetaHuman BODY firing the per-beat
         Animation Montages (M_Explain / M_LeanIn / M_Nod) at their start times,
       - a Face animation track bound to the ACE Audio2Face-3D facial bake
         (lip-sync + Audio2Emotion); see apply_face_animation(),
       - a Cine Camera + Camera Cut track driven by the manifest camera cues
         (shot framing -> focal length + distance, move -> animated transform,
         easing -> key interpolation).
  4. Render to 4K via Movie Render Queue (ProRes), headless when invoked with
     UnrealEditor-Cmd ... -RenderOffscreen.

Invocation (headless), from POC_SETUP.md:

  UnrealEditor-Cmd "<Project>.uproject" /Game/LAS/Maps/L_Stage \
    -game -RenderOffscreen -NoLoadingScreen -NoSplash -Unattended \
    -ExecutePythonScript="render_from_manifest.py \
        --manifest=/path/manifest.json --audio=/path/audio.wav \
        --output-dir=/path/out --output-name=job123"

Argument parsing reads sys.argv after the script path; UE forwards everything
after the script filename inside -ExecutePythonScript.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    import unreal  # type: ignore  # provided only by the UE editor Python runtime
except ImportError:  # pragma: no cover - lets the file import/lint outside UE
    unreal = None  # noqa: N816


# --- Manifest-vocabulary -> engine mapping ---------------------------------
# These mirror the enums in packages/protocol/src/dsl.ts + manifest.ts. The
# manifest already resolved gesture/posture -> montageId and emotion -> A2F, so
# here we only need the *camera* vocabulary -> concrete CineCamera params and the
# montage-id -> asset-path convention.

# Where the POC assets live in the UE content browser.
CONTENT_ROOT = "/Game/LAS"
MONTAGE_DIR = f"{CONTENT_ROOT}/Anims/Montages"
FACE_BAKE_DIR = f"{CONTENT_ROOT}/Faces"  # ACE A2F output, one AnimSequence per job
DEFAULT_METAHUMAN_BP = f"{CONTENT_ROOT}/MetaHumans/Ada/BP_Ada"

# montageId (from manifest) -> AnimMontage asset path.
MONTAGE_ASSETS = {
    "M_Explain": f"{MONTAGE_DIR}/M_Explain",
    "M_LeanIn": f"{MONTAGE_DIR}/M_LeanIn",
    "M_Nod": f"{MONTAGE_DIR}/M_Nod",
}

# Camera shot -> (focal length mm, dolly distance from subject in cm, framing
# height offset in cm above the actor pivot for a ~170cm MetaHuman).
SHOT_PARAMS = {
    "wide": (24.0, 400.0, 100.0),
    "full": (35.0, 300.0, 95.0),
    "medium": (50.0, 200.0, 120.0),
    "medium_close": (65.0, 140.0, 145.0),
    "close_up": (85.0, 100.0, 160.0),
    "extreme_close_up": (100.0, 60.0, 162.0),
}

# Camera target -> look-at height (cm) on the subject.
TARGET_HEIGHT = {
    "eyes": 165.0,
    "face": 160.0,
    "chest": 130.0,
    "torso": 110.0,
    "full_body": 90.0,
}


def log(msg: str) -> None:
    if unreal is not None:
        unreal.log(f"[LAS render] {msg}")
    else:
        print(f"[LAS render] {msg}")


def parse_args() -> argparse.Namespace:
    # UE forwards the full -ExecutePythonScript string; argv[0] is the script.
    argv = sys.argv[1:]
    p = argparse.ArgumentParser(description="Render a PerformanceManifest via MRQ")
    p.add_argument("--manifest", required=True, help="Path to manifest.json")
    p.add_argument("--audio", required=True, help="Path to the TTS audio .wav")
    p.add_argument("--output-dir", required=True, help="Directory for the 4K render")
    p.add_argument("--output-name", default="performance", help="Output file stem")
    p.add_argument(
        "--face-anim",
        default=None,
        help="Asset path to the ACE A2F facial bake; defaults to "
        f"{FACE_BAKE_DIR}/<jobId>_Face",
    )
    return p.parse_args(argv)


def load_manifest(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        m = json.load(f)
    if m.get("version") != 1:
        raise ValueError(f"unsupported manifest version {m.get('version')}")
    return m


# --- UE time helpers --------------------------------------------------------


def seconds_to_frame(seconds: float, fps: int) -> "unreal.FrameNumber":
    return unreal.FrameNumber(round(seconds * fps))


# --- Level / actors ---------------------------------------------------------


def open_stage(level_path: str) -> None:
    les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    les.load_level(level_path)
    log(f"opened stage level {level_path}")


def find_metahuman(metahuman_bp: str) -> "unreal.Actor":
    """Return the MetaHuman actor already placed in the level, or spawn one."""
    actor_sys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for actor in actor_sys.get_all_level_actors():
        if metahuman_bp.split("/")[-1] in actor.get_actor_label():
            return actor
    bp_class = unreal.EditorAssetLibrary.load_blueprint_class(metahuman_bp)
    return actor_sys.spawn_actor_from_class(
        bp_class, unreal.Vector(0, 0, 0), unreal.Rotator(0, 0, 0)
    )


def get_body_and_face(metahuman: "unreal.Actor"):
    """MetaHuman BPs expose a 'Body' and 'Face' SkeletalMeshComponent."""
    body = None
    face = None
    for comp in metahuman.get_components_by_class(unreal.SkeletalMeshComponent):
        name = comp.get_name().lower()
        if "face" in name:
            face = comp
        elif "body" in name:
            body = comp
    return body, face


# --- Sequence construction --------------------------------------------------


def create_sequence(output_name: str, fps: int) -> "unreal.LevelSequence":
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    seq = tools.create_asset(
        asset_name=f"LS_{output_name}",
        package_path=f"{CONTENT_ROOT}/Sequences",
        asset_class=unreal.LevelSequence,
        factory=unreal.LevelSequenceFactoryNew(),
    )
    seq.set_display_rate(unreal.FrameRate(fps, 1))
    return seq


def add_audio_track(seq: "unreal.LevelSequence", audio_path: str, fps: int, duration_s: float) -> None:
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    import_task = unreal.AssetImportTask()
    import_task.filename = audio_path
    import_task.destination_path = f"{CONTENT_ROOT}/Audio"
    import_task.automated = True
    import_task.replace_existing = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([import_task])
    sound = unreal.EditorAssetLibrary.load_asset(import_task.imported_object_paths[0])

    track = seq.add_track(unreal.MovieSceneAudioTrack)
    section = track.add_section()
    section.set_sound(sound)
    section.set_range(0, round(duration_s * fps))
    log("bound TTS audio to master audio track")


def add_body_montages(seq, body_binding, beats, fps) -> None:
    track = body_binding.add_track(unreal.MovieSceneSkeletalAnimationTrack)
    for beat in beats:
        montage_id = beat["body"].get("montageId")
        if not montage_id:
            continue  # idle beat: no montage
        asset_path = MONTAGE_ASSETS.get(montage_id)
        anim = unreal.EditorAssetLibrary.load_asset(asset_path)
        if anim is None:
            log(f"WARN missing montage asset {asset_path} for beat {beat['seq']}")
            continue
        section = track.add_section()
        params = section.get_editor_property("params")
        params.set_editor_property("animation", anim)
        section.set_editor_property("params", params)
        start = beat["startS"]
        section.set_range(round(start * fps), round(beat["endS"] * fps))
        log(f"beat {beat['seq']}: montage {montage_id} @ {start:.2f}s")


def apply_face_animation(seq, face_binding, manifest, face_anim_path, fps) -> None:
    """Bind the ACE Audio2Face-3D facial bake to the MetaHuman Face track.

    The per-beat face drive (manifest.beats[].face: a2fEmotion + intensity) is an
    INPUT to the A2F bake step that runs BEFORE this script (see POC_SETUP.md):
    we feed our TTS audio + the emotion timeline to Audio2Face-3D, which produces
    a single facial AnimSequence covering lip-sync + Audio2Emotion. Here we just
    bind that bake. If it is missing we warn loudly rather than render a
    dead-faced MetaHuman.
    """
    path = face_anim_path or f"{FACE_BAKE_DIR}/{manifest['jobId']}_Face"
    anim = unreal.EditorAssetLibrary.load_asset(path)
    if anim is None:
        log(f"WARN no ACE A2F facial bake at {path}; run the A2F step first")
        return
    track = face_binding.add_track(unreal.MovieSceneSkeletalAnimationTrack)
    section = track.add_section()
    params = section.get_editor_property("params")
    params.set_editor_property("animation", anim)
    section.set_editor_property("params", params)
    section.set_range(0, round(manifest["durationS"] * fps))
    log(f"bound A2F facial bake {path}")


# --- Camera -----------------------------------------------------------------

EASE_INTERP = {
    "linear": "RCIM_Linear",
    "ease_in": "RCIM_Cubic",
    "ease_out": "RCIM_Cubic",
    "ease_in_out": "RCIM_Cubic",
}


def shot_transform(shot: str, target: str, intensity: float):
    """Base camera transform for a shot, facing the subject at origin (0,0,0).
    Camera sits on +X looking toward -X at the target height."""
    focal, distance, _height = SHOT_PARAMS[shot]
    look_h = TARGET_HEIGHT[target]
    location = unreal.Vector(distance, 0.0, look_h)
    rotation = unreal.Rotator(0.0, 0.0, 180.0)  # yaw 180 -> face -X toward subject
    return location, rotation, focal


def move_delta(move: str, distance: float, intensity: float):
    """Location/rotation delta applied from shot start to end over the cue."""
    amt = max(0.0, min(1.0, intensity))
    dloc = unreal.Vector(0, 0, 0)
    dyaw = 0.0
    if move == "dolly_in":
        dloc = unreal.Vector(-distance * 0.4 * amt, 0, 0)
    elif move == "dolly_out":
        dloc = unreal.Vector(distance * 0.4 * amt, 0, 0)
    elif move == "truck_left":
        dloc = unreal.Vector(0, -distance * 0.3 * amt, 0)
    elif move == "truck_right":
        dloc = unreal.Vector(0, distance * 0.3 * amt, 0)
    elif move == "pedestal_up":
        dloc = unreal.Vector(0, 0, distance * 0.2 * amt)
    elif move == "pedestal_down":
        dloc = unreal.Vector(0, 0, -distance * 0.2 * amt)
    elif move == "pan_left":
        dyaw = 12.0 * amt
    elif move == "pan_right":
        dyaw = -12.0 * amt
    elif move == "orbit_left":
        dyaw = 25.0 * amt
    elif move == "orbit_right":
        dyaw = -25.0 * amt
    return dloc, dyaw


def add_camera(seq, manifest, fps):
    actor_sys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    cam = actor_sys.spawn_actor_from_class(
        unreal.CineCameraActor, unreal.Vector(0, 0, 160), unreal.Rotator(0, 180, 0)
    )
    cam.set_actor_label("LAS_CineCamera")
    cam_binding = seq.add_possessable(cam)

    # Camera Cut track makes MRQ render through this camera.
    cut_track = seq.add_track(unreal.MovieSceneCameraCutTrack)
    cut_section = cut_track.add_section()
    cut_section.set_range(0, round(manifest["durationS"] * fps))
    cut_section.set_camera_binding_id(seq.make_binding_id(cam_binding))

    transform_track = cam_binding.add_track(unreal.MovieScene3DTransformTrack)
    transform_section = transform_track.add_section()
    transform_section.set_range(0, round(manifest["durationS"] * fps))
    channels = transform_section.get_all_channels()
    # Channel order: Loc X,Y,Z, Rot X,Y,Z, Scale X,Y,Z.

    cine = cam.get_cine_camera_component()

    for cue in manifest["camera"]:
        start_f = round(cue["startS"] * fps)
        end_f = round((cue["startS"] + cue["durationS"]) * fps)
        loc, rot, focal = shot_transform(cue["shot"], cue["target"], cue["intensity"])
        _, distance, _ = SHOT_PARAMS[cue["shot"]]
        dloc, dyaw = move_delta(cue["move"], distance, cue["intensity"])
        interp = getattr(unreal.MovieSceneKeyInterpolation, _ease_to_enum(cue["easing"]))

        cine.set_editor_property("current_focal_length", focal)

        end_loc = unreal.Vector(loc.x + dloc.x, loc.y + dloc.y, loc.z + dloc.z)
        end_rot = unreal.Rotator(rot.roll, rot.pitch, rot.yaw + dyaw)
        _key_xyz(channels[0:3], start_f, loc, interp)
        _key_xyz(channels[3:6], start_f, _rot_vec(rot), interp)
        _key_xyz(channels[0:3], end_f, end_loc, interp)
        _key_xyz(channels[3:6], end_f, _rot_vec(end_rot), interp)
        log(f"camera cue beat {cue['seq']}: {cue['shot']}/{cue['move']} {focal}mm")


def _ease_to_enum(easing: str) -> str:
    return {
        "linear": "LINEAR",
        "ease_in": "USER",
        "ease_out": "USER",
        "ease_in_out": "AUTO",
    }.get(easing, "AUTO")


def _rot_vec(rot) -> "unreal.Vector":
    return unreal.Vector(rot.roll, rot.pitch, rot.yaw)


def _key_xyz(channels, frame, vec, interp) -> None:
    for ch, val in zip(channels, [vec.x, vec.y, vec.z]):
        ch.add_key(unreal.FrameNumber(frame), val, interpolation=interp)


# --- Movie Render Queue -----------------------------------------------------


def render_mrq(seq, manifest, output_dir, output_name) -> None:
    subsystem = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = subsystem.get_queue()
    queue.delete_all_jobs()
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.sequence = unreal.SoftObjectPath(seq.get_path_name())
    job.map = unreal.SoftObjectPath(unreal.EditorLevelLibrary.get_editor_world().get_path_name())

    config = job.get_configuration()
    config.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)

    out = config.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    res = manifest["resolution"]
    out.output_resolution = unreal.IntPoint(res["width"], res["height"])
    out.output_directory = unreal.DirectoryPath(output_dir)
    out.file_name_format = output_name
    out.output_frame_rate = unreal.FrameRate(manifest["fps"], 1)
    out.use_custom_frame_rate = True

    # ProRes keeps the cinematic master high-quality; mux audio downstream.
    config.find_or_add_setting_by_class(unreal.MoviePipelineAppleProRes422Output)

    aa = config.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    aa.spatial_sample_count = 8
    aa.temporal_sample_count = 1

    executor = unreal.MoviePipelinePIEExecutor()
    log(f"starting MRQ render -> {output_dir}/{output_name} @ {res['width']}x{res['height']}")
    subsystem.render_queue_with_executor_instance(executor)


# --- Entry ------------------------------------------------------------------


def main() -> None:
    if unreal is None:
        raise SystemExit(
            "This script must run inside the Unreal Engine editor Python runtime "
            "(it imports `unreal`). See services/engine/POC_SETUP.md."
        )
    args = parse_args()
    manifest = load_manifest(args.manifest)
    fps = manifest["fps"]
    log(f"manifest job={manifest['jobId']} beats={len(manifest['beats'])} dur={manifest['durationS']:.2f}s")

    open_stage(manifest["stage"]["level"] if "/" in manifest["stage"]["level"]
               else f"{CONTENT_ROOT}/Maps/{manifest['stage']['level']}")
    metahuman = find_metahuman(
        manifest["stage"].get("metahumanId") or DEFAULT_METAHUMAN_BP
        if "/" in (manifest["stage"].get("metahumanId") or "")
        else DEFAULT_METAHUMAN_BP
    )
    body, face = get_body_and_face(metahuman)

    seq = create_sequence(args.output_name, fps)
    mh_binding = seq.add_possessable(metahuman)
    body_binding = seq.add_possessable(body) if body else mh_binding
    face_binding = seq.add_possessable(face) if face else mh_binding

    add_audio_track(seq, args.audio, fps, manifest["audio"]["durationS"])
    add_body_montages(seq, body_binding, manifest["beats"], fps)
    apply_face_animation(seq, face_binding, manifest, args.face_anim, fps)
    add_camera(seq, manifest, fps)

    unreal.EditorAssetLibrary.save_loaded_asset(seq)
    os.makedirs(args.output_dir, exist_ok=True)
    render_mrq(seq, manifest, args.output_dir, args.output_name)


if __name__ == "__main__":
    main()
