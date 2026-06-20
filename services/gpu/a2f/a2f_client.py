"""
Audio2Face-3D client adapter.

Turns speech audio into an ARKit blendshape timeline by streaming it to an
NVIDIA Audio2Face-3D NIM and collecting the animation stream. The request and
response handling mirror NVIDIA's Apache-2.0 reference client
(github.com/NVIDIA/Audio2Face-3D-Samples, scripts/audio2face_3d_api_client).

The browser app (apps/avatar-live) consumes the returned timeline directly via
BlendshapeTimelineLipsync.

IMPORTANT — this requires:
  1. A running A2F-3D NIM (see README.md; quick-start docker-compose).
  2. The generated gRPC stubs from the A2F-3D-Samples proto/ directory on the
     PYTHONPATH (the `nvidia_ace.*` packages). Generate with the repo's
     `proto/build.sh` (protoc) and `pip install` the sample client package.

It has NOT been executed in this repo's CI (no GPU NIM available here); the
message construction follows the reference sample exactly. Confirm the
controller endpoint/service name against your NIM deployment.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass, field

import grpc  # type: ignore
import numpy as np  # type: ignore

# Generated from the A2F-3D-Samples proto/ (nvidia_ace.*). See README.
from nvidia_ace.a2f.v1_pb2 import (  # type: ignore
    AudioStream,
    AudioStreamHeader,
    AudioWithEmotion,
)
from nvidia_ace.audio.v1_pb2 import AudioHeader  # type: ignore
from nvidia_ace.emotion_with_timecode.v1_pb2 import EmotionWithTimeCode  # type: ignore
from nvidia_ace.services.a2f_controller.v1_pb2_grpc import (  # type: ignore
    A2FControllerServiceStub,
)


@dataclass
class A2FConfig:
    """Tunables forwarded to A2F-3D; sensible neutral defaults."""

    face_parameters: dict = field(default_factory=dict)
    blendshape_multipliers: dict = field(default_factory=dict)
    blendshape_offsets: dict = field(default_factory=dict)
    emotion_timecodes: list[dict] = field(default_factory=list)


def _decode_wav(wav_bytes: bytes) -> tuple[int, np.ndarray]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        data = np.frombuffer(raw, dtype=np.int16)
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1).astype(np.int16)
    return rate, data


def _build_header(rate: int, cfg: A2FConfig) -> AudioStream:
    return AudioStream(
        audio_stream_header=AudioStreamHeader(
            audio_header=AudioHeader(
                samples_per_second=rate,
                bits_per_sample=16,
                channel_count=1,
                audio_format=AudioHeader.AUDIO_FORMAT_PCM,
            ),
            face_params=None if not cfg.face_parameters else _face_params(cfg),
        )
    )


def _face_params(cfg: A2FConfig):  # pragma: no cover - thin proto shim
    from nvidia_ace.a2f.v1_pb2 import FaceParameters  # type: ignore

    return FaceParameters(float_params=cfg.face_parameters)


async def _write_audio(stream, rate: int, data: np.ndarray, cfg: A2FConfig) -> None:
    await stream.write(_build_header(rate, cfg))
    emotions = [
        EmotionWithTimeCode(emotion=e["emotions"], time_code=e["time_code"])
        for e in cfg.emotion_timecodes
    ]
    # One second of audio per packet (chunk size is arbitrary).
    for i in range(len(data) // rate + 1):
        chunk = data[i * rate : i * rate + rate]
        if chunk.size == 0:
            continue
        msg = AudioWithEmotion(audio_buffer=chunk.astype(np.int16).tobytes())
        if i == 0 and emotions:
            msg.emotions.extend(emotions)
        await stream.write(AudioStream(audio_with_emotion=msg))
    await stream.write(AudioStream(end_of_audio=AudioStream.EndOfAudio()))


async def _read_animation(stream) -> dict:
    """Collect the AnimationDataStream into our timeline format.

    Mirrors the reference sample's read_from_stream: the header carries the
    blendshape names; each animation_data frame carries time-coded weight arrays.
    """
    names: list[str] = []
    frames: list[dict] = []
    t0: float | None = None

    async for message in stream:
        if message.HasField("animation_data_stream_header"):
            hdr = message.animation_data_stream_header
            names = list(hdr.skel_animation_header.blend_shapes)
        elif message.HasField("animation_data"):
            for bs in message.animation_data.skel_animation.blend_shape_weights:
                if t0 is None:
                    t0 = bs.time_code
                frames.append({"t": bs.time_code - t0, "weights": list(bs.values)})
        elif message.HasField("status"):
            if message.status.code != 0:
                raise RuntimeError(f"A2F status {message.status.code}: {message.status.message}")

    return {"names": names, "frames": frames}


async def audio_to_timeline(wav_bytes: bytes, target: str, cfg: A2FConfig | None = None) -> dict:
    """Stream `wav_bytes` to the A2F-3D controller at `target` → timeline dict.

    `target` is the gRPC address of the A2F-3D controller, e.g. "localhost:52000".
    Returns {"names": [...], "frames": [{"t", "weights"}...]}.
    """
    cfg = cfg or A2FConfig()
    rate, data = _decode_wav(wav_bytes)
    async with grpc.aio.insecure_channel(target) as channel:
        stub = A2FControllerServiceStub(channel)
        # Bidirectional: write audio, read animation. ProcessAudioStream is the
        # controller's duplex RPC in the NIM deployment; adjust to your build.
        call = stub.ProcessAudioStream()

        async def _pump() -> None:
            await _write_audio(call, rate, data, cfg)

        import asyncio

        writer = asyncio.create_task(_pump())
        timeline = await _read_animation(call)
        await writer
    return timeline
