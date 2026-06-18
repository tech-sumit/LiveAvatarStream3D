"""Realtime generation: DSL segment -> streaming XTTS audio -> MuseTalk lip-sync.

Each streamed DSL segment is voiced with the cloned XTTS-v2 voice (in-process,
system interpreter) and lip-synced by MuseTalk (out-of-process, isolated venv —
see ``musetalk_worker.py``). Output is emitted one ``AvFrame`` per video frame
with the matching slice of 16 kHz audio so the publisher can keep A/V in lockstep.

  segment.text --XTTS--> audio chunks (24k) --resample--> 16k wav
       16k wav --MuseTalk worker--> composited full BGR frames (idle.mp4 base)
       frame[j] + audio[j*40ms] --> AvFrame

MuseTalk preparation (precompute the avatar latents/masks from idle.mp4) runs
once at ``warm()`` and is cached on the volume per avatar, so subsequent
sessions for the same avatar skip it.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from typing import Iterator, Optional

import numpy as np

from las_common import get_tier
from las_common import optim
from las_common import (
    DEFAULT_CLIP,
    manifest_path,
    map_dsl_to_clip,
    read_manifest,
    realtime_expressive_enabled,
)
from stt import load_model as load_stt_model

TTS_SR = 24000          # XTTS-v2 native sample rate
AUDIO_SR = 16000        # publisher / MuseTalk audio rate
MIN_CHUNK_S = 0.4       # accumulate streamed TTS before a MuseTalk pass

# MuseTalk's audio_processor builds a fixed-width whisper window per output frame
# and `assert`s that every frame gets a full window; on a too-short clip the
# assert fails and the upstream library calls `exit()`, which kills the worker
# subprocess (parent then sees its stdout EOF as "exited before 'done'" and the
# whole generation leg dies, bricking the session). The streamed final remainder
# of a segment can be that short (a sub-0.2s tail yields 6 whisper columns vs the
# 10 required), so every chunk handed to MuseTalk is padded up to this floor.
_MIN_MUSETALK_SAMPLES = int(MIN_CHUNK_S * AUDIO_SR)

# Ceiling on expressive base clips prepared per session, to bound VRAM. The
# motion-state catalog is ~10 clips; this leaves headroom and is the parent-side
# guard mirrored by the worker's own --max-clips cap.
_MAX_EXPRESSIVE_CLIPS = int(os.environ.get("MUSETALK_MAX_CLIPS", "12"))

# Frames blended across a clip switch (expressive only) to smooth the cut.
_CROSSFADE_FRAMES = 5


@dataclass
class AvFrame:
    pcm16: bytes          # 16k mono PCM16 for this frame's duration (or b"" silence)
    image_bgr: object     # np.ndarray HxWx3 BGR full frame (or None)
    pts_ms: int


def _resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr or len(audio) == 0:
        return audio.astype("float32")
    n = int(round(len(audio) * dst_sr / src_sr))
    xp = np.linspace(0.0, 1.0, len(audio), dtype="float64")
    x = np.linspace(0.0, 1.0, max(1, n), dtype="float64")
    return np.interp(x, xp, audio).astype("float32")


def _to_pcm16(audio_f32: np.ndarray) -> bytes:
    return (np.clip(audio_f32, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class StreamingTTS:
    """Coqui XTTS-v2 streaming synthesis with a one-time cloned-voice conditioning."""

    def __init__(self, voice_sample_path: str):
        self.voice_sample_path = voice_sample_path
        self._model = None
        self._gpt_cond = None
        self._speaker_emb = None

    def warm(self) -> None:
        from TTS.api import TTS

        api = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
        self._model = api.synthesizer.tts_model
        self._gpt_cond, self._speaker_emb = self._model.get_conditioning_latents(
            audio_path=[self.voice_sample_path]
        )

    def stream(self, text: str, lang: str = "en") -> Iterator[np.ndarray]:
        """Yield float32 mono audio chunks at TTS_SR for ``text``."""
        if self._model is None:
            self.warm()
        text = text.strip()
        if not text:
            return
        import torch

        for chunk in self._model.inference_stream(
            text, lang, self._gpt_cond, self._speaker_emb,
            stream_chunk_size=20, enable_text_splitting=True,
        ):
            if isinstance(chunk, torch.Tensor):
                chunk = chunk.detach().cpu().numpy()
            yield np.asarray(chunk, dtype="float32").reshape(-1)


class MuseTalkHead:
    """Drives the persistent MuseTalk worker subprocess (isolated venv).

    Holds the per-session avatar prep and streams composited frames per audio
    chunk. Frame buffers are exchanged via a raw file on the (fast) volume so the
    heavy MuseTalk deps stay out of this interpreter.
    """

    def __init__(self, *, avatar_id: str, video_path: str, fps: int, batch_size: int):
        self.avatar_id = avatar_id
        self.video_path = video_path
        self.fps = fps
        self.batch_size = batch_size
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        # Per-clip rolling frame index keyed by the clip_id sent on infer (None
        # for the single/legacy clip). The parent owns continuity so switching
        # base clips between segments resumes each clip's loop where it left off.
        self._idx: dict = {}
        self._req = 0
        self.frame_h = 0
        self.frame_w = 0
        self.clip_ids: list = []  # prepared clip ids (expressive); [] in single-clip mode
        self._scratch = tempfile.TemporaryDirectory(prefix="musetalk_io_")

    def warm(self, clips: Optional[list] = None) -> None:
        """Spawn the worker and prepare avatar clips.

        ``clips`` is an optional list of ``(clip_id, video_path)``: when given
        (expressive mode) each is prepared and held in the worker keyed by id.
        When ``None`` (default) a single idle clip is prepared with no clip_id —
        byte-for-byte the legacy single-avatar path.
        """
        python = os.environ.get("MUSETALK_PYTHON", "python3")
        root = os.environ.get("MUSETALK_ROOT", "/workspace/repos/MuseTalk")
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "musetalk_worker.py")
        version = os.environ.get("MUSETALK_VERSION", "v15")
        bbox_shift = int(os.environ.get("MUSETALK_BBOX_SHIFT", "0"))

        env = dict(os.environ)
        env.setdefault("HF_HOME", os.environ.get("HF_HOME", "/workspace/.model_cache"))
        env["MUSETALK_ROOT"] = root

        self._proc = subprocess.Popen(
            [python, worker, "--musetalk-root", root, "--version", version,
             "--fps", str(self.fps), "--batch-size", str(self.batch_size)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            cwd=root, env=env, text=True, bufsize=1,
        )
        self._await_event("ready", timeout=600)
        if clips is None:
            self._send({"cmd": "prepare", "avatar_id": self.avatar_id,
                        "video_path": self.video_path, "bbox_shift": bbox_shift})
            self._await_event("prepared", timeout=900)
        else:
            for clip_id, video_path in clips:
                try:
                    self._send({"cmd": "prepare", "avatar_id": self.avatar_id, "clip_id": clip_id,
                                "video_path": video_path, "bbox_shift": bbox_shift})
                    self._await_event("prepared", timeout=900)
                except Exception as exc:  # noqa: BLE001
                    # One clip failing to prepare (e.g. no detectable face in that
                    # motion loop) must not brick the whole session: skip it and
                    # keep the clips that did prepare — idle stays the fallback.
                    # A dead worker is different (nothing more can prepare), so
                    # re-raise to let the session tear down cleanly.
                    if self._proc is None or self._proc.poll() is not None:
                        raise
                    print(f"[musetalk] prepare failed for clip {clip_id!r}; skipping: {exc!r}", flush=True)
                    continue
                self.clip_ids.append(clip_id)

    def _send(self, obj: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(json.dumps(obj) + "\n")
        self._proc.stdin.flush()

    def _await_event(self, event: str, timeout: float) -> dict:
        # Bind the stream locally: close() (called from the event loop during a
        # forceful teardown) nulls self._proc while this runs on a worker thread.
        # Reading self._proc each iteration would race that to an AttributeError;
        # the killed worker's stdout instead gives a clean EOF -> RuntimeError,
        # which unblocks the abandoned executor step at once.
        assert self._proc and self._proc.stdout
        stream = self._proc.stdout
        while True:
            line = stream.readline()
            if not line:
                raise RuntimeError(f"musetalk worker exited before '{event}'")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # tolerate library noise printed to the worker's stdout
            if not isinstance(msg, dict) or "event" not in msg:
                continue
            if msg.get("event") == "error":
                raise RuntimeError(f"musetalk worker error: {msg.get('detail')}")
            if msg.get("event") == event:
                return msg

    def step(self, wav_16k_path: str, clip_id: Optional[str] = None) -> Iterator[np.ndarray]:
        """Run one MuseTalk pass over a 16k wav; yield composited BGR frames.

        ``clip_id`` selects which prepared avatar to lip-sync onto. ``None``
        (default) targets the single/legacy clip and emits the exact legacy
        infer message (no ``clip_id`` field), preserving byte-for-byte behavior.
        """
        with self._lock:
            self._req += 1
            out_dir = os.path.join(self._scratch.name, f"req{self._req}")
            msg = {"cmd": "infer", "req": self._req, "audio": wav_16k_path,
                   "out": out_dir, "start_idx": self._idx.get(clip_id, 0)}
            if clip_id is not None:
                msg["clip_id"] = clip_id
            self._send(msg)
            res = self._await_event("done", timeout=300)
            self._idx[clip_id] = int(res["next_idx"])
            n, h, w = int(res["frames"]), int(res["h"]), int(res["w"])
            self.frame_h, self.frame_w = h, w
            raw = res["raw"]
        if n == 0 or h == 0:
            shutil.rmtree(out_dir, ignore_errors=True)
            return
        buf = np.fromfile(raw, dtype=np.uint8)
        buf = buf[: n * h * w * 3].reshape(n, h, w, 3)
        for j in range(n):
            yield buf[j]
        # Drop this request's scratch dir (raw frame dump) so per-req{N} dirs
        # don't pile up in the session tempdir over a long conversation.
        shutil.rmtree(out_dir, ignore_errors=True)

    def close(self) -> None:
        """Forcefully terminate the worker; prompt and idempotent.

        Do NOT send {"cmd":"shutdown"} and wait for a clean exit: the worker only
        reads stdin between infers, so a shutdown request sits unread behind an
        in-flight MuseTalk pass (up to its 300s infer timeout) and so does
        proc.wait(). Killing the process directly closes its stdout, which gives
        an EOF to any parent thread blocked in _await_event's readline — that
        in-flight step() then errors out at once instead of running to
        completion. SIGTERM with a short grace, then SIGKILL; the OS reclaims the
        GPU memory on process death. Never acquires _lock (a step() may hold it),
        so it can't deadlock against the call it is interrupting."""
        proc = self._proc
        self._proc = None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()  # SIGTERM
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.wait(timeout=0.5)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()  # SIGKILL after grace
                    proc.wait(timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
        self._scratch.cleanup()


class RealtimeGenerator:
    """Holds the warm XTTS voice + MuseTalk head for one session."""

    def __init__(self, *, tier: str, voice_sample_path: str, ref_dir: str,
                 idle_video_path: str, avatar_id: str, engine: str = "xtts_v2"):
        self.tier = get_tier(tier)
        self.voice_sample_path = voice_sample_path
        self.ref_dir = ref_dir
        self.idle_video_path = idle_video_path
        self.avatar_id = avatar_id
        self.engine = engine
        self._tts: Optional[StreamingTTS] = None
        self._head: Optional[MuseTalkHead] = None
        self._idle_cycle: list = []
        self._idle_idx = 0
        self._pts = 0
        self._samples_per_frame = AUDIO_SR // self.tier.target_fps
        self.stt_model = None  # pre-warmed faster-whisper model handed to StreamingSTT
        # Expressive motion-state library. Off => single-idle path (today's
        # behavior). Set in warm() once the manifest + flag are confirmed.
        self._expressive = False
        self._clip_ids: list = []
        # Extra non-speech ambient pose cycles (expressive only), keyed by clip
        # id (currently just "listening"). `idle` deliberately stays in
        # _idle_cycle/_idle_idx so the flag-off ambient path is byte-for-byte
        # today's idle behavior.
        self._ambient_cycles: dict = {}
        self._ambient_idx: dict = {}
        # Clip-switch crossfade state (expressive only). When generate() starts
        # emitting a clip id different from the previous one, the first
        # _CROSSFADE_FRAMES frames are blended from the previous clip's last
        # emitted frame (alpha 0->1). Untouched on the flag-off path.
        self._prev_clip_id: Optional[str] = None
        self._last_frame = None
        self._blend_from = None
        self._blend_total = 0
        self._blend_done = 0

    @property
    def expressive(self) -> bool:
        """True once warm() confirmed the flag + a usable motion manifest."""
        return self._expressive

    def warm(self) -> None:
        optim.enable_fast_math()
        self._tts = StreamingTTS(self.voice_sample_path)
        self._tts.warm()
        self._head = MuseTalkHead(
            avatar_id=self.avatar_id,
            video_path=self.idle_video_path,
            fps=self.tier.target_fps,
            batch_size=int(os.environ.get("MUSETALK_BATCH", "8")),
        )
        clips = self._resolve_expressive_clips()
        self._head.warm(clips)
        # Only go expressive if at least one clip actually prepared; if every
        # clip was skipped (all failed) fall back to the single-idle path rather
        # than running expressive with an empty clip set.
        if clips is not None and self._head.clip_ids:
            self._expressive = True
            self._clip_ids = list(self._head.clip_ids)
            print(f"[warm] expressive ON: prepared {len(self._clip_ids)} clips {self._clip_ids}")
        elif clips is not None:
            print("[warm] expressive requested but no clips prepared; using single-idle path")
        self._load_idle_cycle()
        self._load_ambient_cycles()
        if os.environ.get("REALTIME_PREWARM", "1") != "0":
            self._prewarm_stt()
            self._prewarm_av_pipeline()

    def _resolve_expressive_clips(self) -> Optional[list]:
        """Return ``[(clip_id, video_path), ...]`` to prepare in expressive mode,
        or ``None`` to fall back to today's single-idle prepare.

        Expressive requires both the flag AND a real manifest on disk; otherwise
        (flag off, or no manifest) we degrade to the single idle clip. Clip files
        that aren't present on the volume are skipped, and the set is bounded to
        ``_MAX_EXPRESSIVE_CLIPS`` to cap VRAM. If nothing usable survives, we
        return ``None`` so the legacy path runs unchanged.
        """
        if not realtime_expressive_enabled():
            return None
        if not os.path.exists(manifest_path(self.ref_dir)):
            return None
        manifest = read_manifest(self.ref_dir)
        clips: list = []
        for clip_id, video_path in manifest.items():
            if len(clips) >= _MAX_EXPRESSIVE_CLIPS:
                break
            if os.path.exists(video_path):
                clips.append((clip_id, video_path))
        return clips or None

    def _prewarm_stt(self) -> None:
        """Load + CUDA-warm faster-whisper so the first real turn skips the
        ~9s STT cold start. Best-effort: never fails session setup."""
        try:
            model = load_stt_model()
            segments, _ = model.transcribe(
                np.zeros(AUDIO_SR, dtype="float32"), language="en", beam_size=1)
            list(segments)  # consume the lazy generator so CUDA kernels actually run
            self.stt_model = model
        except Exception as exc:  # noqa: BLE001
            print(f"[warm] STT pre-warm skipped: {exc}")

    def _prewarm_av_pipeline(self) -> None:
        """Push one tiny synthetic utterance through XTTS -> MuseTalk and discard
        the frames, erasing the ~6s first-turn XTTS+MuseTalk kernel warmup.
        Best-effort; restores session counters so the first real turn is clean."""
        saved_pts, saved_idle = self._pts, self._idle_idx
        saved_head_idx = dict(self._head._idx) if self._head else {}
        try:
            produced = 0
            for _ in self.generate({"text": "Hello.", "language": "en"}):
                produced += 1
                if produced >= 2:
                    break
        except Exception as exc:  # noqa: BLE001
            print(f"[warm] A/V pipeline pre-warm skipped: {exc}")
        finally:
            self._pts, self._idle_idx = saved_pts, saved_idle
            if self._head is not None:
                self._head._idx = saved_head_idx
            # Drop any crossfade armed by the throwaway prewarm utterance so the
            # first real turn never blends from a discarded "Hello." frame.
            self.reset_continuity()

    @staticmethod
    def _load_cycle(video_path: str) -> list:
        """Read a base clip into a ping-pong frame cycle (frames + reversed) so
        the loop has no seam at the wrap. Returns [] if the file yields nothing."""
        import cv2

        frames = []
        cap = cv2.VideoCapture(video_path)
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frames.append(frame)
        cap.release()
        return frames + frames[::-1] if frames else []

    def _load_idle_cycle(self) -> None:
        self._idle_cycle = self._load_cycle(self.idle_video_path)

    def _load_ambient_cycles(self) -> None:
        """Expressive only: load base-frame cycles for the non-idle ambient poses
        (currently ``listening``) from the manifest, mirroring _load_idle_cycle.
        A pose whose clip is absent is simply skipped, so ambient_frame() falls
        back to the idle cycle and the flag-off path is unchanged."""
        if not self._expressive:
            return
        manifest = read_manifest(self.ref_dir)
        for pose in ("listening",):
            path = manifest.get(pose)
            if path and os.path.exists(path):
                self._ambient_cycles[pose] = self._load_cycle(path)
                self._ambient_idx[pose] = 0

    def generate(self, segment: dict) -> Iterator[AvFrame]:
        """Yield AvFrames (lip-synced video + aligned 16k audio) for one DSL segment."""
        assert self._tts and self._head
        text = segment["text"]
        lang = segment.get("language", "en")
        clip_id = self._select_clip_id(segment)

        pending = np.zeros(0, dtype="float32")  # buffered 16k audio
        for chunk24 in self._tts.stream(text, lang):
            pending = np.concatenate([pending, _resample(chunk24, TTS_SR, AUDIO_SR)])
            if len(pending) >= int(MIN_CHUNK_S * AUDIO_SR):
                yield from self._emit_chunk(pending, clip_id)
                pending = np.zeros(0, dtype="float32")
        if len(pending) > 0:
            yield from self._emit_chunk(pending, clip_id)

    def _select_clip_id(self, segment: dict) -> Optional[str]:
        """Map a segment's DSL to a prepared clip id, or ``None`` when expressive
        is off (legacy single-clip path). Falls back to ``idle``/``DEFAULT_CLIP``
        if the mapped clip wasn't prepared for this avatar."""
        if not self._expressive:
            return None
        clip = map_dsl_to_clip(
            segment.get("emotion", "neutral"),
            segment.get("gesture", "none"),
            segment.get("posture", "neutral"),
        )
        if clip in self._clip_ids:
            return clip
        if "idle" in self._clip_ids:
            return "idle"
        if DEFAULT_CLIP in self._clip_ids:
            return DEFAULT_CLIP
        return self._clip_ids[0] if self._clip_ids else None

    def reset_continuity(self) -> None:
        """Drop any armed clip-switch crossfade + the cached on-screen frame.

        The crossfade blends a new clip from the *previously emitted* frame; if
        ambient (idle/listening) frames have taken over the screen between turns,
        or a barge-in cut the avatar off, that cached frame is no longer what's
        displayed. Resetting here means the next spoken chunk starts clean (its
        first switch records the clip without arming a blend) instead of fading
        in from a stale frame. Expressive-only state — a no-op on the flag-OFF
        single-clip path (these fields are never read there)."""
        self._prev_clip_id = None
        self._last_frame = None
        self._blend_from = None
        self._blend_total = 0
        self._blend_done = 0

    def _begin_clip(self, clip_id: Optional[str]) -> None:
        """Arm a crossfade when this chunk's clip differs from the last emitted
        one. Captures the previous clip's last frame as the blend source; the
        first switch of the session (no previous frame) just records the clip."""
        if clip_id == self._prev_clip_id:
            return
        if self._prev_clip_id is not None and self._last_frame is not None:
            self._blend_from = self._last_frame
            self._blend_total = _CROSSFADE_FRAMES
            self._blend_done = 0
        self._prev_clip_id = clip_id

    def _apply_crossfade(self, frame):
        """Linearly blend ``frame`` (new clip) toward 1.0 over the armed window,
        starting from the previous clip's last frame. Pass-through once the
        window is spent or on a shape mismatch (clips should share framing)."""
        if self._blend_done >= self._blend_total or self._blend_from is None:
            return frame
        if self._blend_from.shape != frame.shape:
            self._blend_done = self._blend_total
            return frame
        alpha = (self._blend_done + 1) / (self._blend_total + 1)
        blended = (
            frame.astype("float32") * alpha + self._blend_from.astype("float32") * (1.0 - alpha)
        ).astype("uint8")
        self._blend_done += 1
        return blended

    def _emit_chunk(self, audio_16k: np.ndarray, clip_id: Optional[str] = None) -> Iterator[AvFrame]:
        assert self._head
        if 0 < len(audio_16k) < _MIN_MUSETALK_SAMPLES:
            audio_16k = np.concatenate(
                [audio_16k, np.zeros(_MIN_MUSETALK_SAMPLES - len(audio_16k), dtype="float32")]
            )
        if self._expressive:
            self._begin_clip(clip_id)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = tf.name
        try:
            self._write_wav(wav_path, audio_16k, AUDIO_SR)
            pcm = _to_pcm16(audio_16k)
            spf_bytes = self._samples_per_frame * 2
            # Off path calls step(wav_path) exactly as before (single positional
            # arg); only thread clip_id through when expressive is active.
            frames = self._head.step(wav_path) if clip_id is None else self._head.step(wav_path, clip_id)
            for j, frame in enumerate(frames):
                self._pts += int(1000 / self.tier.target_fps)
                if self._expressive:
                    frame = self._apply_crossfade(frame)
                    self._last_frame = frame
                start = j * spf_bytes
                slice_pcm = pcm[start:start + spf_bytes]
                if len(slice_pcm) < spf_bytes:
                    slice_pcm = slice_pcm + b"\x00" * (spf_bytes - len(slice_pcm))
                yield AvFrame(pcm16=slice_pcm, image_bgr=frame, pts_ms=self._pts)
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    @staticmethod
    def _write_wav(path: str, audio_f32: np.ndarray, sr: int) -> None:
        import soundfile as sf

        sf.write(path, np.clip(audio_f32, -1.0, 1.0), sr, subtype="PCM_16")

    def ambient_frame(self, pose: str = "idle") -> AvFrame:
        """One ambient (non-speech) frame cycling ``pose``'s base frames.

        ``pose='idle'`` is the unchanged idle cycle (_idle_cycle/_idle_idx). In
        expressive mode a prepared pose (e.g. ``listening``) cycles its own
        loaded frames; any pose without loaded frames falls back to the idle
        cycle. With expressive off only ``idle`` is ever requested, so this is
        byte-for-byte today's idle_frame()."""
        self._pts += int(1000 / self.tier.target_fps)
        # An ambient frame is now what's on screen, so any crossfade armed from a
        # prior spoken frame is stale; clear it so the next turn starts clean.
        # Expressive-only: the flag-OFF idle path leaves this state untouched.
        if self._expressive:
            self.reset_continuity()
        cycle = self._ambient_cycles.get(pose) if pose != "idle" else None
        if cycle:
            img = cycle[self._ambient_idx[pose] % len(cycle)]
            self._ambient_idx[pose] += 1
            return AvFrame(pcm16=b"", image_bgr=img, pts_ms=self._pts)
        img = None
        if self._idle_cycle:
            img = self._idle_cycle[self._idle_idx % len(self._idle_cycle)]
            self._idle_idx += 1
        return AvFrame(pcm16=b"", image_bgr=img, pts_ms=self._pts)

    def idle_frame(self) -> AvFrame:
        return self.ambient_frame("idle")

    def close(self) -> None:
        if self._head:
            self._head.close()
            self._head = None
