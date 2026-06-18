"""Persistent MuseTalk realtime inference worker (runs in the isolated MuseTalk venv).

MuseTalk (TMElyralab/MuseTalk) pins diffusers 0.30.2 / transformers 4.39.2 /
numpy 1.23.5 + mmpose(dwpose), which conflict with the realtime service's system
interpreter (coqui-tts / faster-whisper / aiortc). So MuseTalk runs here, under
its own interpreter (``MUSETALK_PYTHON``), as a long-lived subprocess that the
realtime ``generate.py`` drives over a line protocol on stdin/stdout.

Lifecycle (mirrors scripts/realtime_inference.py's ``Avatar``):
  1. startup  -> load UNet+VAE+PositionalEncoding, Whisper, AudioProcessor,
                 FaceParsing once (the heavy, one-time cost).
  2. prepare  -> from the avatar idle clip: extract frames, detect face bbox,
                 VAE-encode each 256x256 face crop into a latent, build the
                 forward+backward "cycle" + blending masks. Cached on the volume
                 under ``--cache-dir/<avatar_id>`` so a warm restart skips it.
  3. infer    -> per audio chunk: Whisper features -> per-frame audio prompt ->
                 UNet denoise(latent, audio) -> VAE decode -> 256x256 mouth crop
                 -> blended back into the full original frame. Frames are written
                 as a single raw BGR buffer; the parent reads them back.

Source verified against:
  https://github.com/TMElyralab/MuseTalk/blob/main/scripts/realtime_inference.py
  https://github.com/TMElyralab/MuseTalk/blob/main/musetalk/utils/audio_processor.py
  https://github.com/TMElyralab/MuseTalk/blob/main/musetalk/utils/blending.py

Protocol (one JSON object per line, request/response).

Single-clip (legacy / flag-OFF) — unchanged, byte-for-byte:
  <- {"cmd":"prepare","avatar_id":..,"video_path":..,"bbox_shift":0}
  -> {"event":"prepared","n_cycle":N}
  <- {"cmd":"infer","req":1,"audio":"/p.wav","out":"/d","start_idx":0}
  -> {"event":"done","req":1,"frames":N,"next_idx":K,"h":H,"w":W,"raw":"/d/frames.raw"}
  <- {"cmd":"shutdown"}

Multi-clip (expressive) — additive. Each ``prepare`` carries a ``clip_id`` and the
worker holds one prepared avatar (latents/masks/frame cycle) per id, each with its
own rolling frame index. ``infer`` selects the prepared avatar by ``clip_id``:
  <- {"cmd":"prepare","avatar_id":..,"clip_id":"explaining","video_path":..,"bbox_shift":0}
  -> {"event":"prepared","n_cycle":N,"clip_id":"explaining","n_clips":M}
  <- {"cmd":"infer","req":1,"clip_id":"emphatic","audio":"/p.wav","out":"/d","start_idx":0}
  -> {"event":"done","req":1,"frames":N,"next_idx":K,"h":H,"w":W,"raw":"/d/frames.raw","clip_id":"emphatic"}

The two extra response fields (``clip_id`` on prepare/infer, ``n_clips`` on prepare)
are emitted ONLY when the request named a ``clip_id``; a request without one yields
the exact legacy response above. ``start_idx`` is optional on ``infer`` — when
omitted the worker advances the selected clip's own per-clip frame index. ``clip_id``
on ``infer`` is optional and defaults to the single/most-recently-prepared clip, so a
single ``prepare`` + ``infer`` with no ``clip_id`` behaves exactly as the legacy path.
A ``{"event":"ready"}`` line is emitted once models are loaded.
"""

from __future__ import annotations

import argparse
import copy
import glob
import json
import os
import pickle
import shutil
import sys

import cv2
import numpy as np
import torch


# The protocol channel to the parent is a dedicated dup of the original stdout
# fd; everything else (library prints, C-level writes to fd 1) is routed to
# stderr so it can never corrupt the JSON line protocol. Set up in main().
_PIPE = sys.stdout


def _emit(obj: dict) -> None:
    _PIPE.write(json.dumps(obj) + "\n")
    _PIPE.flush()


def _log(*a) -> None:
    print("[musetalk-worker]", *a, file=sys.stderr, flush=True)


def _isolate_stdout() -> None:
    """Reserve fd1 as the parent pipe; send all other stdout to stderr."""
    global _PIPE
    _PIPE = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)          # fd1 (and anything writing to it) -> stderr
    sys.stdout = sys.stderr


# Key under which a clip prepared WITHOUT an explicit clip_id is stored. The
# legacy single-idle path uses this so a clip_id-less infer resolves to it and
# stays byte-for-byte identical to the pre-expressive behavior.
_DEFAULT_KEY = "__default__"


class PreparedClip:
    """One prepared avatar (latents / masks / frame cycle) + its rolling index.

    The frame index is per-clip so switching base clips between segments and
    later switching back resumes each clip's body loop where it left off, rather
    than snapping to the start. The parent normally supplies ``start_idx`` per
    infer (it owns continuity across clips); ``frame_idx`` is the worker-side
    fallback used when ``start_idx`` is omitted.
    """

    __slots__ = (
        "frame_list_cycle",
        "coord_list_cycle",
        "input_latent_list_cycle",
        "mask_list_cycle",
        "mask_coords_list_cycle",
        "frame_idx",
    )

    def __init__(self, frame_list_cycle, coord_list_cycle, input_latent_list_cycle,
                 mask_list_cycle, mask_coords_list_cycle):
        self.frame_list_cycle = frame_list_cycle
        self.coord_list_cycle = coord_list_cycle
        self.input_latent_list_cycle = input_latent_list_cycle
        self.mask_list_cycle = mask_list_cycle
        self.mask_coords_list_cycle = mask_coords_list_cycle
        self.frame_idx = 0


class MuseTalkRuntime:
    """Holds the warm MuseTalk models + the prepared avatar clips for one session."""

    def __init__(self, args):
        self.version = args.version
        self.fps = args.fps
        self.batch_size = args.batch_size
        self.extra_margin = args.extra_margin
        self.parsing_mode = args.parsing_mode
        self.audio_pad_left = args.audio_padding_length_left
        self.audio_pad_right = args.audio_padding_length_right
        self.cache_root = args.cache_dir
        # Cap on simultaneously-held prepared clips, to bound VRAM. The realtime
        # generator bounds the set it prepares too; this is a defensive ceiling.
        self.max_clips = max(1, int(getattr(args, "max_clips", 12)))

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._load_models(args)

        # Prepared avatars keyed by clip_id (insertion-ordered for LRU eviction).
        # The legacy single-clip path stores one entry under _DEFAULT_KEY.
        self.clips: dict[str, PreparedClip] = {}
        self.default_clip_id: str | None = None

    def _load_models(self, args) -> None:
        from transformers import WhisperModel

        from musetalk.utils.utils import load_all_model
        from musetalk.utils.audio_processor import AudioProcessor
        from musetalk.utils.face_parsing import FaceParsing

        _log(f"loading models version={self.version} unet={args.unet_model_path}")
        self.vae, self.unet, self.pe = load_all_model(
            unet_model_path=args.unet_model_path,
            vae_type=args.vae_type,
            unet_config=args.unet_config,
            device=self.device,
        )
        self.timesteps = torch.tensor([0], device=self.device)
        self.pe = self.pe.half().to(self.device)
        self.vae.vae = self.vae.vae.half().to(self.device)
        self.unet.model = self.unet.model.half().to(self.device)
        self.weight_dtype = self.unet.model.dtype

        self.audio_processor = AudioProcessor(feature_extractor_path=args.whisper_dir)
        self.whisper = WhisperModel.from_pretrained(args.whisper_dir)
        self.whisper = self.whisper.to(device=self.device, dtype=self.weight_dtype).eval()
        self.whisper.requires_grad_(False)

        if self.version == "v15":
            self.fp = FaceParsing(
                left_cheek_width=args.left_cheek_width,
                right_cheek_width=args.right_cheek_width,
            )
        else:
            self.fp = FaceParsing()
        _log("models loaded")

    # --- preparation (precompute avatar latents + blending material) ----------

    def prepare(self, avatar_id: str, video_path: str, bbox_shift: int,
                clip_id: str | None = None) -> tuple[int, str]:
        # clip_id None == legacy single-idle path: cache dir == avatar_id (so an
        # existing on-disk cache is reused unchanged) and stored under _DEFAULT_KEY.
        key = clip_id if clip_id is not None else _DEFAULT_KEY
        cache_id = avatar_id if clip_id is None else f"{avatar_id}__{clip_id}"
        cache = os.path.join(self.cache_root, cache_id if self.version != "v15" else f"{self.version}_{cache_id}")
        info_path = os.path.join(cache, "avator_info.json")
        wanted = {"avatar_id": avatar_id, "bbox_shift": bbox_shift, "version": self.version}
        if clip_id is not None:
            wanted["clip_id"] = clip_id

        clip = None
        if os.path.exists(info_path):
            try:
                with open(info_path) as f:
                    cached = json.load(f)
                if cached.get("bbox_shift") == bbox_shift and cached.get("version") == self.version:
                    clip = self._load_cache(cache)
                    _log(f"loaded cached avatar {cache_id} ({len(clip.frame_list_cycle)} cycle frames)")
            except Exception as e:  # noqa: BLE001
                _log(f"cache load failed ({e}); rebuilding")
            if clip is None:
                shutil.rmtree(cache, ignore_errors=True)

        if clip is None:
            clip = self._build_cache(cache, video_path, bbox_shift, wanted)

        self._store_clip(key, clip)
        if clip_id is None:
            # Legacy single-idle path: the no-clip_id clip is the default.
            self.default_clip_id = key
        elif self.default_clip_id is None and clip_id == "idle":
            # Expressive path: every clip carries a clip_id, so the branch above
            # never fires. Anchor the fallback to "idle" the moment it prepares so
            # _select_clip has a stable default and eviction never drops it (the
            # _store_clip guard also protects default_clip_id + the "idle" literal).
            self.default_clip_id = "idle"
        return len(clip.frame_list_cycle), key

    def _store_clip(self, key: str, clip: PreparedClip) -> None:
        """Insert a prepared clip, evicting the oldest evictable one if at cap."""
        if key not in self.clips and len(self.clips) >= self.max_clips:
            for victim in list(self.clips.keys()):
                if victim != self.default_clip_id and victim != "idle":
                    self.clips.pop(victim, None)
                    _log(f"evicted clip {victim} to bound VRAM (cap={self.max_clips})")
                    break
        self.clips[key] = clip

    def _select_clip(self, clip_id: str | None) -> tuple[str, PreparedClip]:
        """Resolve a request clip_id to a prepared clip, with stable fallbacks."""
        if clip_id is not None and clip_id in self.clips:
            return clip_id, self.clips[clip_id]
        if self.default_clip_id and self.default_clip_id in self.clips:
            return self.default_clip_id, self.clips[self.default_clip_id]
        for fallback in ("idle", "explaining"):
            if fallback in self.clips:
                return fallback, self.clips[fallback]
        key = next(iter(self.clips))
        return key, self.clips[key]

    def n_clips(self) -> int:
        return len(self.clips)

    def _cache_paths(self, cache: str) -> dict:
        return {
            "full_imgs": os.path.join(cache, "full_imgs"),
            "mask": os.path.join(cache, "mask"),
            "coords": os.path.join(cache, "coords.pkl"),
            "mask_coords": os.path.join(cache, "mask_coords.pkl"),
            "latents": os.path.join(cache, "latents.pt"),
            "info": os.path.join(cache, "avator_info.json"),
        }

    def _load_cache(self, cache: str) -> PreparedClip:
        from musetalk.utils.preprocessing import read_imgs

        p = self._cache_paths(cache)
        input_latent_list_cycle = torch.load(p["latents"])
        with open(p["coords"], "rb") as f:
            coord_list_cycle = pickle.load(f)
        imgs = sorted(glob.glob(os.path.join(p["full_imgs"], "*.png")),
                      key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))
        frame_list_cycle = read_imgs(imgs)
        with open(p["mask_coords"], "rb") as f:
            mask_coords_list_cycle = pickle.load(f)
        masks = sorted(glob.glob(os.path.join(p["mask"], "*.png")),
                       key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))
        mask_list_cycle = read_imgs(masks)
        return PreparedClip(frame_list_cycle, coord_list_cycle, input_latent_list_cycle,
                            mask_list_cycle, mask_coords_list_cycle)

    def _build_cache(self, cache: str, video_path: str, bbox_shift: int, info: dict) -> PreparedClip:
        from musetalk.utils.preprocessing import get_landmark_and_bbox
        from musetalk.utils.blending import get_image_prepare_material

        p = self._cache_paths(cache)
        for d in (cache, p["full_imgs"], p["mask"]):
            os.makedirs(d, exist_ok=True)
        with open(p["info"], "w") as f:
            json.dump(info, f)

        _log(f"extracting frames from {video_path}")
        self._video_to_imgs(video_path, p["full_imgs"])
        img_list = sorted(glob.glob(os.path.join(p["full_imgs"], "*.png")),
                          key=lambda x: int(os.path.splitext(os.path.basename(x))[0]))

        _log("detecting landmarks / bbox")
        coord_list, frame_list = get_landmark_and_bbox(img_list, bbox_shift)

        input_latent_list = []
        placeholder = (0.0, 0.0, 0.0, 0.0)
        for idx, (bbox, frame) in enumerate(zip(coord_list, frame_list)):
            if bbox == placeholder:
                continue
            x1, y1, x2, y2 = bbox
            if self.version == "v15":
                y2 = min(y2 + self.extra_margin, frame.shape[0])
                coord_list[idx] = [x1, y1, x2, y2]
            crop = frame[y1:y2, x1:x2]
            crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
            input_latent_list.append(self.vae.get_latents_for_unet(crop))

        # Forward + reverse so the body loops smoothly.
        frame_list_cycle = frame_list + frame_list[::-1]
        coord_list_cycle = coord_list + coord_list[::-1]
        input_latent_list_cycle = input_latent_list + input_latent_list[::-1]
        mask_list_cycle = []
        mask_coords_list_cycle = []

        mode = self.parsing_mode if self.version == "v15" else "raw"
        for i, frame in enumerate(frame_list_cycle):
            cv2.imwrite(os.path.join(p["full_imgs"], f"{i:08d}.png"), frame)
            x1, y1, x2, y2 = coord_list_cycle[i]
            mask, crop_box = get_image_prepare_material(frame, [x1, y1, x2, y2], fp=self.fp, mode=mode)
            cv2.imwrite(os.path.join(p["mask"], f"{i:08d}.png"), mask)
            mask_list_cycle.append(mask)
            mask_coords_list_cycle.append(crop_box)

        with open(p["mask_coords"], "wb") as f:
            pickle.dump(mask_coords_list_cycle, f)
        with open(p["coords"], "wb") as f:
            pickle.dump(coord_list_cycle, f)
        torch.save(input_latent_list_cycle, p["latents"])
        _log(f"prepared {len(frame_list_cycle)} cycle frames")
        return PreparedClip(frame_list_cycle, coord_list_cycle, input_latent_list_cycle,
                            mask_list_cycle, mask_coords_list_cycle)

    @staticmethod
    def _video_to_imgs(video_path: str, save_path: str) -> None:
        cap = cv2.VideoCapture(video_path)
        count = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            cv2.imwrite(os.path.join(save_path, f"{count:08d}.png"), frame)
            count += 1
        cap.release()

    # --- per-chunk inference ---------------------------------------------------

    @torch.no_grad()
    def infer(self, audio_path: str, out_dir: str, start_idx: int | None = None,
              clip_id: str | None = None) -> dict:
        from musetalk.utils.utils import datagen
        from musetalk.utils.blending import get_image_blending

        resolved_id, clip = self._select_clip(clip_id)
        if start_idx is None:
            start_idx = clip.frame_idx

        feats, librosa_len = self.audio_processor.get_audio_feature(audio_path, weight_dtype=self.weight_dtype)
        whisper_chunks = self.audio_processor.get_whisper_chunk(
            feats, self.device, self.weight_dtype, self.whisper, librosa_len,
            fps=self.fps,
            audio_padding_length_left=self.audio_pad_left,
            audio_padding_length_right=self.audio_pad_right,
        )
        video_num = len(whisper_chunks)
        cycle = len(clip.input_latent_list_cycle)

        res_frames = []
        gen = datagen(whisper_chunks, clip.input_latent_list_cycle, self.batch_size,
                      delay_frame=start_idx % cycle, device=str(self.device))
        for whisper_batch, latent_batch in gen:
            audio_feature_batch = self.pe(whisper_batch.to(self.device))
            latent_batch = latent_batch.to(device=self.device, dtype=self.unet.model.dtype)
            pred_latents = self.unet.model(latent_batch, self.timesteps,
                                           encoder_hidden_states=audio_feature_batch).sample
            pred_latents = pred_latents.to(device=self.device, dtype=self.vae.vae.dtype)
            recon = self.vae.decode_latents(pred_latents)
            for f in recon:
                res_frames.append(f)

        os.makedirs(out_dir, exist_ok=True)
        raw_path = os.path.join(out_dir, "frames.raw")
        h = w = None
        n = 0
        with open(raw_path, "wb") as raw:
            for j, res_frame in enumerate(res_frames):
                idx = (start_idx + j) % cycle
                bbox = clip.coord_list_cycle[idx]
                ori = copy.deepcopy(clip.frame_list_cycle[idx])
                x1, y1, x2, y2 = bbox
                try:
                    face = cv2.resize(res_frame.astype(np.uint8), (x2 - x1, y2 - y1))
                except Exception:  # noqa: BLE001
                    continue
                mask = clip.mask_list_cycle[idx]
                mask_box = clip.mask_coords_list_cycle[idx]
                combined = get_image_blending(ori, face, bbox, mask, mask_box)
                combined = np.ascontiguousarray(combined, dtype=np.uint8)
                if h is None:
                    h, w = combined.shape[0], combined.shape[1]
                raw.write(combined.tobytes())
                n += 1

        next_idx = (start_idx + n) % cycle
        clip.frame_idx = next_idx
        res = {"frames": n, "next_idx": next_idx, "h": h or 0, "w": w or 0, "raw": raw_path}
        if clip_id is not None:
            res["clip_id"] = resolved_id
        return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--musetalk-root", default=os.environ.get("MUSETALK_ROOT", "/workspace/repos/MuseTalk"))
    ap.add_argument("--cache-dir", default=os.environ.get("MUSETALK_AVATAR_CACHE", "/workspace/musetalk-avatars"))
    ap.add_argument("--version", default=os.environ.get("MUSETALK_VERSION", "v15"), choices=["v1", "v15"])
    ap.add_argument("--vae-type", default="sd-vae")
    ap.add_argument("--unet-config", default=None)
    ap.add_argument("--unet-model-path", default=None)
    ap.add_argument("--whisper-dir", default=None)
    ap.add_argument("--fps", type=int, default=int(os.environ.get("MUSETALK_FPS", "25")))
    ap.add_argument("--batch-size", type=int, default=int(os.environ.get("MUSETALK_BATCH", "8")))
    ap.add_argument("--extra-margin", type=int, default=10)
    ap.add_argument("--parsing-mode", default="jaw")
    ap.add_argument("--left-cheek-width", type=int, default=90)
    ap.add_argument("--right-cheek-width", type=int, default=90)
    ap.add_argument("--audio-padding-length-left", type=int, default=2)
    ap.add_argument("--audio-padding-length-right", type=int, default=2)
    ap.add_argument("--max-clips", type=int, default=int(os.environ.get("MUSETALK_MAX_CLIPS", "12")))
    args = ap.parse_args()

    _isolate_stdout()
    os.chdir(args.musetalk_root)
    if args.musetalk_root not in sys.path:
        sys.path.insert(0, args.musetalk_root)

    models = os.path.join(args.musetalk_root, "models")
    if args.version == "v15":
        args.unet_model_path = args.unet_model_path or os.path.join(models, "musetalkV15", "unet.pth")
        args.unet_config = args.unet_config or os.path.join(models, "musetalkV15", "musetalk.json")
    else:
        args.unet_model_path = args.unet_model_path or os.path.join(models, "musetalk", "pytorch_model.bin")
        args.unet_config = args.unet_config or os.path.join(models, "musetalk", "musetalk.json")
    args.whisper_dir = args.whisper_dir or os.path.join(models, "whisper")
    os.makedirs(args.cache_dir, exist_ok=True)

    runtime = MuseTalkRuntime(args)
    _emit({"event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _emit({"event": "error", "detail": "bad json"})
            continue
        cmd = msg.get("cmd")
        try:
            if cmd == "prepare":
                clip_id = msg.get("clip_id")
                n, _key = runtime.prepare(msg["avatar_id"], msg["video_path"],
                                          int(msg.get("bbox_shift", 0)), clip_id)
                resp = {"event": "prepared", "n_cycle": n}
                if clip_id is not None:
                    resp["clip_id"] = clip_id
                    resp["n_clips"] = runtime.n_clips()
                _emit(resp)
            elif cmd == "infer":
                start = msg.get("start_idx")
                start = int(start) if start is not None else None
                res = runtime.infer(msg["audio"], msg["out"], start, msg.get("clip_id"))
                res.update({"event": "done", "req": msg.get("req")})
                _emit(res)
            elif cmd == "shutdown":
                _emit({"event": "bye"})
                break
            else:
                _emit({"event": "error", "detail": f"unknown cmd {cmd}"})
        except Exception as e:  # noqa: BLE001
            import traceback

            _log(traceback.format_exc())
            _emit({"event": "error", "req": msg.get("req"), "detail": str(e)})


if __name__ == "__main__":
    main()
