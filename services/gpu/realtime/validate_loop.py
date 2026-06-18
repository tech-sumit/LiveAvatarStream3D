"""End-to-end validation of the realtime conversational loop (no SFU / WebRTC).

Exercises the FULL production loop on the GPU node, minus the Cloudflare SFU
transport leg (validated separately):

  user speech wav
    --faster-whisper (stt.StreamingSTT)--> transcript          [STT]
    --POST live Worker /api/director/draft--> DSL segments      [director / OpenRouter Claude]
    --RealtimeGenerator.generate (XTTS-v2 -> MuseTalk worker)--> AvFrames
    --assemble--> talking-head mp4 (+ optional R2 upload)

Then it drives the SessionRuntime generation loop directly and fires a barge-in
``cancel`` mid-generation to prove in-flight frames are preempted (epoch bump +
queue drain), all without a real WebRTC peer.

Measures and reports, as JSON:
  - STT transcription latency (compute, excluding the fixed VAD endpoint budget),
  - turn-response latency (transcript -> first DSL segment -> first A/V frame),
  - steady-state video fps + per-MuseTalk-chunk time, total per-turn wall time,
  - barge-in: frames produced after cancel + queue drain.

Run on the pod (system interpreter; spawns the MuseTalk venv via MUSETALK_PYTHON):

  source /workspace/las_env.sh
  cd /opt/las/services/gpu/realtime
  python3 validate_loop.py \
      --avatar-prefix demo-user/av_mqicx7h6cd0e9a4db55a \
      --voice-prefix  demo-user/vo_mqicx8cmab1b88aa8632 \
      --speech-from /workspace/demo_video.mp4 \
      --out /workspace/loop_validation.mp4 --upload
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import tempfile
import time
from typing import Optional

import numpy as np

from las_common import R2Client
from generate import RealtimeGenerator, AUDIO_SR
from stt import StreamingSTT, SAMPLE_RATE as STT_SR, FRAME_MS, SILENCE_MS

CONTROL_API = os.environ.get("CONTROL_API_URL", "https://las-control-api.tech-sumit.workers.dev")


# --------------------------------------------------------------------------- #
# helpers                                                                      #
# --------------------------------------------------------------------------- #

def _download_avatar(r2: R2Client, bucket: str, prefix: str, dst: str) -> tuple[str, str]:
    os.makedirs(dst, exist_ok=True)
    for i in range(8):
        try:
            r2.download(bucket, f"{prefix}/keyframes/{i:02d}.png", os.path.join(dst, f"{i:02d}.png"))
        except Exception:
            break
    idle = os.path.join(dst, "idle.mp4")
    r2.download(bucket, f"{prefix}/idle.mp4", idle)
    return dst, idle


def _extract_speech_16k(src: str, dst_wav: str, seconds: float) -> np.ndarray:
    """Pull mono 16k PCM speech from any media file (the simulated user mic)."""
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-t", str(seconds),
         "-ac", "1", "-ar", str(STT_SR), "-f", "wav", dst_wav],
        check=True,
    )
    import soundfile as sf

    audio, sr = sf.read(dst_wav, dtype="int16")
    assert sr == STT_SR
    if audio.ndim > 1:
        audio = audio[:, 0]
    return audio.astype("<i2")


def run_stt(speech_i16: np.ndarray) -> tuple[str, float]:
    """Feed the simulated mic through the production StreamingSTT; return
    (transcript, compute_latency_s). The 800ms VAD endpoint budget is fed as a
    tight loop so the measured cost is the faster-whisper transcribe pass."""
    captured: dict = {}

    def on_final(text: str) -> None:
        captured["text"] = text
        captured["t"] = time.perf_counter()

    stt = StreamingSTT(on_final=on_final)
    stt._ensure()  # load whisper + vad once (excluded from the measured latency)
    # faster-whisper returns a lazy segment generator; consume it so CUDA kernels
    # / autotuning are actually warmed before the measured pass (otherwise the
    # one-time warmup lands on the first real transcribe).
    _warm_segs, _ = stt._model.transcribe(
        np.zeros(STT_SR * 3, dtype="float32"), language="en", beam_size=1)
    list(_warm_segs)

    frame_bytes = int(STT_SR * FRAME_MS / 1000) * 2
    raw = speech_i16.tobytes()
    for i in range(0, len(raw) - frame_bytes + 1, frame_bytes):
        stt.push(raw[i:i + frame_bytes])

    silence = b"\x00" * frame_bytes
    t_speech_done = time.perf_counter()
    n_silence = (SILENCE_MS // FRAME_MS) + 5
    for _ in range(n_silence):
        if "text" in captured:
            break
        stt.push(silence)

    text = captured.get("text", "")
    latency = captured.get("t", time.perf_counter()) - t_speech_done
    return text, latency


def fetch_dsl(transcript: str, persona: str, language: str) -> tuple[list[dict], float]:
    """Drive the live Worker director (OpenRouter Claude) -> DSL segments."""
    import httpx

    prompt = f"The user just said: \"{transcript}\". Respond naturally and briefly."
    t0 = time.perf_counter()
    res = httpx.post(
        f"{CONTROL_API}/api/director/draft",
        json={"prompt": prompt, "persona": persona, "language": language},
        timeout=30,
    )
    res.raise_for_status()
    script = res.json()
    dt = time.perf_counter() - t0
    lang = script.get("language", language)
    segments = []
    for seg in script.get("segments", []):
        seg = dict(seg)
        seg.setdefault("language", lang)
        segments.append(seg)
    return segments, dt


# --------------------------------------------------------------------------- #
# generation measurement                                                       #
# --------------------------------------------------------------------------- #

def _instrument_musetalk(gen: RealtimeGenerator, chunk_times: list[dict]) -> None:
    """Wrap the MuseTalk head's step() to record per-chunk frame count + time."""
    head = gen._head
    orig = head.step

    def timed_step(wav_path: str):
        t0 = time.perf_counter()
        frames = list(orig(wav_path))
        chunk_times.append({"frames": len(frames), "seconds": time.perf_counter() - t0})
        return iter(frames)

    head.step = timed_step  # type: ignore[method-assign]


def generate_turn(gen: RealtimeGenerator, segments: list[dict]) -> dict:
    """Feed DSL segments through the generator, collect A/V, measure latencies."""
    chunk_times: list[dict] = []
    _instrument_musetalk(gen, chunk_times)

    frames: list[np.ndarray] = []
    pcm = bytearray()
    frame_times: list[float] = []

    t_start = time.perf_counter()
    t_first_video: Optional[float] = None
    t_first_audio: Optional[float] = None
    per_seg = []

    for si, seg in enumerate(segments):
        t_seg = time.perf_counter()
        seg_frames = 0
        for av in gen.generate(seg):
            now = time.perf_counter()
            if av.image_bgr is not None:
                if t_first_video is None:
                    t_first_video = now
                frames.append(av.image_bgr)
                frame_times.append(now)
                seg_frames += 1
            if av.pcm16:
                if t_first_audio is None:
                    t_first_audio = now
                pcm.extend(av.pcm16)
        per_seg.append({"seq": seg.get("seq", si), "frames": seg_frames,
                        "seconds": round(time.perf_counter() - t_seg, 3)})

    t_end = time.perf_counter()

    # Steady-state fps from inter-frame deltas (drop the first frame, which
    # carries the cold first-chunk MuseTalk + TTS warmup).
    fps = 0.0
    if len(frame_times) > 2:
        deltas = np.diff(np.array(frame_times[1:]))
        if len(deltas) and deltas.mean() > 0:
            fps = float(1.0 / deltas.mean())

    return {
        "frames": frames,
        "pcm": pcm,
        "n_frames": len(frames),
        "audio_s": round(len(pcm) / 2 / AUDIO_SR, 3),
        "t_first_video_s": round((t_first_video - t_start), 3) if t_first_video else None,
        "t_first_audio_s": round((t_first_audio - t_start), 3) if t_first_audio else None,
        "total_gen_s": round(t_end - t_start, 3),
        "steady_fps": round(fps, 2),
        "per_segment": per_seg,
        "musetalk_chunks": chunk_times,
        "musetalk_avg_chunk_s": round(np.mean([c["seconds"] for c in chunk_times]), 3) if chunk_times else None,
        "musetalk_avg_ms_per_frame": round(
            1000 * sum(c["seconds"] for c in chunk_times) / max(1, sum(c["frames"] for c in chunk_times)), 1
        ) if chunk_times else None,
    }


def assemble_mp4(frames: list[np.ndarray], pcm: bytearray, fps: int, out: str, work: str) -> None:
    import cv2
    import soundfile as sf

    fdir = os.path.join(work, "frames")
    os.makedirs(fdir, exist_ok=True)
    for i, f in enumerate(frames):
        cv2.imwrite(os.path.join(fdir, f"{i:06d}.png"), f)
    wav = os.path.join(work, "loop_audio.wav")
    sf.write(wav, np.frombuffer(bytes(pcm), dtype="<i2").astype("float32") / 32768.0, AUDIO_SR)
    silent = os.path.join(work, "loop_silent.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", str(fps), "-i",
                    os.path.join(fdir, "%06d.png"), "-pix_fmt", "yuv420p", silent], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", silent, "-i", wav,
                    "-c:v", "copy", "-c:a", "aac", "-shortest", out], check=True)


# --------------------------------------------------------------------------- #
# barge-in (exercises SessionRuntime epoch/cancel without the SFU)             #
# --------------------------------------------------------------------------- #

async def run_bargein(gen: RealtimeGenerator, segment: dict) -> dict:
    """Drive the real SessionRuntime generation loop and cancel mid-flight."""
    from runtime import SessionRuntime

    rt = SessionRuntime("validate-bargein", {"sessionId": "validate-bargein"}, gen)
    rt._running = True
    task = asyncio.create_task(rt._generation_loop())

    await rt.ingest({"type": "segment", "epoch": 0, "segment": segment})

    # Wait until generation is clearly in flight (frames flowing).
    t_wait = time.perf_counter()
    while rt._video_q.qsize() < 6:
        if time.perf_counter() - t_wait > 60:
            break
        await asyncio.sleep(0.02)
    produced_before = rt._video_q.qsize()

    # Barge-in: bump epoch + drain queues (exactly what SessionDO.bargeIn posts).
    await rt.ingest({"type": "cancel", "epoch": 1})
    drained_to = rt._video_q.qsize()

    # Count any frames that leak in after the cancel over a short window.
    await asyncio.sleep(1.0)
    after_cancel = rt._video_q.qsize()

    rt._running = False
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass

    return {
        "frames_in_queue_before_cancel": produced_before,
        "queue_size_immediately_after_cancel": drained_to,
        "frames_leaked_after_cancel": after_cancel,
        "epoch_after": rt.epoch,
        "preempted": after_cancel <= 1 and drained_to == 0,
    }


# --------------------------------------------------------------------------- #
# main                                                                         #
# --------------------------------------------------------------------------- #

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--avatar-prefix", required=True)
    ap.add_argument("--voice-prefix", required=True)
    ap.add_argument("--avatar-id", default=None)
    ap.add_argument("--speech-from", default="/workspace/demo_video.mp4",
                    help="media file to extract the simulated user mic audio from")
    ap.add_argument("--speech-seconds", type=float, default=6.0)
    ap.add_argument("--transcript", default=None,
                    help="skip STT and use this transcript directly")
    ap.add_argument("--persona", default="A warm, concise, helpful realtime video assistant.")
    ap.add_argument("--language", default="en")
    ap.add_argument("--tier", default="fast")
    ap.add_argument("--out", default="/workspace/loop_validation.mp4")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--out-bucket", default=os.environ.get("R2_OUTPUTS_BUCKET", "las-outputs"))
    ap.add_argument("--out-key", default="validation/realtime_loop.mp4")
    ap.add_argument("--metrics-key", default="validation/realtime_loop_metrics.json")
    ap.add_argument("--skip-bargein", action="store_true")
    ap.add_argument("--no-prewarm", action="store_true",
                    help="measure the cold first turn instead of a warm (turn 2+) turn")
    args = ap.parse_args()

    avatars_bucket = os.environ.get("R2_AVATARS_BUCKET", "las-avatars")
    voices_bucket = os.environ.get("R2_VOICES_BUCKET", "las-voices")
    avatar_id = args.avatar_id or args.avatar_prefix.rstrip("/").split("/")[-1]

    report: dict = {"avatar_id": avatar_id, "control_api": CONTROL_API, "tier": args.tier}

    r2 = R2Client()
    work = tempfile.mkdtemp(prefix="loop_validate_")
    ref_dir, idle_path = _download_avatar(r2, avatars_bucket, args.avatar_prefix, os.path.join(work, "ref"))
    voice_sample = r2.download(voices_bucket, f"{args.voice_prefix}/sample.wav", os.path.join(work, "voice.wav"))
    print(f"[loop] avatar={avatar_id} idle={idle_path} voice={voice_sample}")

    # --- 1. STT -----------------------------------------------------------
    if args.transcript:
        transcript, stt_latency = args.transcript, 0.0
        print(f"[loop] STT skipped; transcript='{transcript}'")
    else:
        speech = _extract_speech_16k(args.speech_from, os.path.join(work, "speech16k.wav"), args.speech_seconds)
        print(f"[loop] extracted {len(speech)/STT_SR:.2f}s of user speech; running STT...")
        transcript, stt_latency = run_stt(speech)
        print(f"[loop] STT transcript='{transcript}' ({stt_latency*1000:.0f}ms compute)")
    report["stt"] = {"transcript": transcript, "transcribe_latency_ms": round(stt_latency * 1000, 1),
                     "vad_endpoint_budget_ms": SILENCE_MS}
    if not transcript:
        raise SystemExit("[loop] FAIL: STT produced empty transcript")

    # --- 2. director -> DSL ----------------------------------------------
    print("[loop] requesting DSL from director (live Worker / OpenRouter Claude)...")
    segments, dsl_latency = fetch_dsl(transcript, args.persona, args.language)
    print(f"[loop] director returned {len(segments)} segment(s) in {dsl_latency*1000:.0f}ms")
    for s in segments:
        print(f"        [{s.get('seq')}] ({s.get('emotion')}/{s.get('gesture')}) {s.get('text')!r}")
    report["director"] = {"n_segments": len(segments), "draft_latency_ms": round(dsl_latency * 1000, 1),
                          "segments": [{"seq": s.get("seq"), "text": s.get("text"),
                                        "emotion": s.get("emotion"), "gesture": s.get("gesture")} for s in segments]}
    if not segments:
        raise SystemExit("[loop] FAIL: director returned no segments")

    # --- 3. warm + generate ----------------------------------------------
    gen = RealtimeGenerator(tier=args.tier, voice_sample_path=voice_sample, ref_dir=ref_dir,
                            idle_video_path=idle_path, avatar_id=avatar_id)
    print("[loop] warming generator (XTTS + MuseTalk worker + avatar prep)...")
    t_warm = time.perf_counter()
    gen.warm()
    report["warm_s"] = round(time.perf_counter() - t_warm, 2)
    print(f"[loop] warm complete in {report['warm_s']}s")

    # The first XTTS inference + first MuseTalk infer pay a one-time CUDA
    # kernel-warmup cost (~seconds). In production the node stays warm across
    # turns, so do a throwaway pass first and report that cold cost separately;
    # the measured turn then reflects steady (turn 2+) latency.
    if not args.no_prewarm:
        print("[loop] pre-warm pass (one-time CUDA kernel warmup, excluded from turn metrics)...")
        cw = generate_turn(gen, [{"text": "Hello there.", "language": args.language}])
        report["cold_start"] = {"first_frame_s": cw["t_first_video_s"],
                                "musetalk_first_chunk_s": cw["musetalk_chunks"][0]["seconds"] if cw["musetalk_chunks"] else None}
        print(f"[loop] cold-start first-frame={cw['t_first_video_s']}s; now measuring warm turn...")

    g = generate_turn(gen, segments)
    frames, pcm = g.pop("frames"), g.pop("pcm")
    report["generation"] = g

    # turn-response: transcript ready -> first A/V frame (STT excluded; that's
    # the user-perceived budget once they stop speaking).
    turn_response_ms = round((dsl_latency + (g["t_first_video_s"] or 0)) * 1000, 1)
    report["turn_response_ms"] = turn_response_ms
    print(f"[loop] turn-response (transcript->first video) = {turn_response_ms}ms "
          f"(director {dsl_latency*1000:.0f}ms + gen first-frame {(g['t_first_video_s'] or 0)*1000:.0f}ms)")
    print(f"[loop] {g['n_frames']} frames, {g['audio_s']}s audio, steady_fps={g['steady_fps']}, "
          f"musetalk {g['musetalk_avg_ms_per_frame']}ms/frame")

    # --- sanity: talking face --------------------------------------------
    if not frames:
        raise SystemExit("[loop] FAIL: no frames produced")
    h, w = frames[0].shape[:2]
    arr = np.stack(frames).astype("float32")
    mean_lum = float(arr.mean())
    inter = float(np.abs(np.diff(arr[:, h // 2:, :, :], axis=0)).mean()) if len(frames) > 1 else 0.0
    ok = mean_lum > 8.0 and inter > 0.4
    report["sanity"] = {"resolution": f"{w}x{h}", "mean_luminance": round(mean_lum, 1),
                        "lower_face_interframe_delta": round(inter, 3),
                        "is_talking_face": bool(ok)}
    print(f"[loop] sanity: {w}x{h} lum={mean_lum:.1f} motion={inter:.3f} talking_face={ok}")

    # --- 4. assemble + upload --------------------------------------------
    assemble_mp4(frames, pcm, gen.tier.target_fps, args.out, work)
    report["artifact"] = {"path": args.out, "bytes": os.path.getsize(args.out)}
    print(f"[loop] wrote {args.out} ({os.path.getsize(args.out)} bytes)")

    # --- 5. barge-in ------------------------------------------------------
    if not args.skip_bargein:
        long_seg = {"text": "Let me walk you through this in a fair amount of detail so we can "
                            "clearly test interruption while I am still speaking out loud.",
                    "language": args.language}
        print("[loop] barge-in: starting a long segment then cancelling mid-generation...")
        bi = asyncio.run(run_bargein(gen, long_seg))
        report["bargein"] = bi
        print(f"[loop] barge-in: {bi}")

    gen.close()

    if args.upload:
        r2.upload(args.out, args.out_bucket, args.out_key, "video/mp4")
        report["artifact"]["r2"] = f"r2://{args.out_bucket}/{args.out_key}"
        metrics_path = os.path.join(work, "metrics.json")
        with open(metrics_path, "w") as f:
            json.dump(report, f, indent=2)
        r2.upload(metrics_path, args.out_bucket, args.metrics_key, "application/json")
        report["metrics_r2"] = f"r2://{args.out_bucket}/{args.metrics_key}"
        print(f"[loop] uploaded -> r2://{args.out_bucket}/{args.out_key}")

    print("\n===== METRICS =====")
    print(json.dumps(report, indent=2))

    pass_ok = ok and (report.get("bargein", {}).get("preempted", True))
    print("\n[loop] " + ("PASS: full realtime loop validated end-to-end." if pass_ok
                          else "FAIL: see metrics above."))
    if not pass_ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
