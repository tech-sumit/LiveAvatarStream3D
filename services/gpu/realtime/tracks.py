"""aiortc media tracks backed by the generation output queues.

The video track pulls composited ``AvFrame``s; the audio track pulls raw 16 kHz
PCM16 bytes and re-packetizes them into fixed 20 ms frames (what Opus expects).
When a queue is empty the tracks emit the last frame / silence so the WebRTC
stream never stalls between turns.

These tracks are published to the Cloudflare Realtime SFU via the control-plane
``/rt/*`` routes (driven from ``runtime.py``). The avatar publishes VP8 video +
Opus audio; the SFU does not transcode, so codecs are pinned at offer time via
:func:`prefer_codec` to the most reliable cross-browser pair.
"""

from __future__ import annotations

import asyncio
import time
from fractions import Fraction

import numpy as np

from aiortc import VideoStreamTrack, RTCRtpSender
from aiortc.mediastreams import AudioStreamTrack

# Stable track names exchanged across the SFU (mirrors @las/protocol RT_TRACKS).
# The avatar (GPU) publishes avatar-audio + avatar-video; the browser publishes
# mic-audio. The control plane resolves subscribe refs by these exact names.
AVATAR_AUDIO = "avatar-audio"
AVATAR_VIDEO = "avatar-video"
MIC_AUDIO = "mic-audio"


def prefer_codec(transceiver, kind: str, mime_type: str) -> None:
    """Pin a transceiver to a single codec before createOffer.

    The CF SFU forwards media without transcoding, so the avatar's publish offer
    must already speak the codec every browser can decode: VP8 for video, Opus
    for audio. Restricting codec preferences to one mimeType keeps the negotiated
    payload unambiguous. No-op if the runtime lacks the capability (older aiortc).
    """
    caps = RTCRtpSender.getCapabilities(kind)
    if not caps:
        return
    prefs = [c for c in caps.codecs if c.mimeType.lower() == mime_type.lower()]
    if prefs:
        transceiver.setCodecPreferences(prefs)


def publish_tracks(audio_mid: str, video_mid: str) -> list[dict]:
    """Build the /rt/publish ``tracks`` body from the local offer's mids."""
    return [
        {"mid": audio_mid, "trackName": AVATAR_AUDIO, "kind": "audio"},
        {"mid": video_mid, "trackName": AVATAR_VIDEO, "kind": "video"},
    ]


class AvatarVideoTrack(VideoStreamTrack):
    def __init__(self, video_queue: "asyncio.Queue", fps: int = 25):
        super().__init__()
        self._q = video_queue
        self._fps = fps
        self._last = None
        self._frame_idx = 0
        # aiortc's VP8 encoder only sends a keyframe on the very first frame or
        # on a PLI (gop_size is ~120s/3000 frames). The CF SFU does not reliably
        # round-trip a late subscriber's PLI to the publisher, so a browser that
        # joins mid-stream gets RTP but never a decodable frame. Emit a periodic
        # keyframe so any late join recovers within ~KEYFRAME_INTERVAL frames.
        #
        # Mechanism (verified on the pod, aiortc 1.14.0): Vp8Encoder.encode()
        # reformats bgr24->yuv420p and that conversion PRESERVES frame.pict_type,
        # which the ffmpeg libvpx wrapper maps to VPX_EFLAG_FORCE_KF. Setting
        # pict_type = I below therefore forces a real VP8 keyframe (confirmed by
        # parsing the emitted VP8 payload descriptor's key-frame bit) -- this is
        # equivalent to the sender's force_keyframe path, no PLI required.
        self._keyframe_interval = max(1, fps * 2)

    async def recv(self):
        import av

        pts, time_base = await self.next_timestamp()
        try:
            item = await asyncio.wait_for(self._q.get(), timeout=1.0 / self._fps)
            if item.image_bgr is not None:
                self._last = item.image_bgr
        except asyncio.TimeoutError:
            pass

        img = self._last if self._last is not None else np.zeros((512, 512, 3), dtype="uint8")
        frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(img), format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        if self._frame_idx % self._keyframe_interval == 0:
            frame.pict_type = av.video.frame.PictureType.I
        self._frame_idx += 1
        return frame


class AvatarAudioTrack(AudioStreamTrack):
    FRAME_MS = 20

    def __init__(self, audio_queue: "asyncio.Queue", sample_rate: int = 16000):
        super().__init__()
        self._q = audio_queue
        self._sr = sample_rate
        self._samples = int(sample_rate * self.FRAME_MS / 1000)
        self._buf = bytearray()
        # aiortc's AudioStreamTrack has no next_timestamp() (only VideoStreamTrack
        # does), so we keep our own monotonic clock at the track's real sample
        # rate. Calling the missing method would raise on the first recv and kill
        # the audio sender -> the SFU then sees no avatar-audio packets.
        self._timestamp = 0
        self._start: float | None = None

    def drain(self) -> None:
        """Drop any buffered partial frame (called on barge-in) so a stale
        fragment from the interrupted turn never plays into the next one."""
        self._buf.clear()

    async def recv(self):
        import av

        # Pace frames in real time at FRAME_MS cadence so the Opus encoder gets
        # a steady stream (silence between turns keeps the track alive). Use a
        # monotonic clock so a wall-clock (NTP) adjustment can't skew pacing.
        if self._start is None:
            self._start = time.monotonic()
        else:
            self._timestamp += self._samples
            wait = self._start + self._timestamp / self._sr - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)

        need = self._samples * 2  # PCM16 bytes for one 20ms frame
        while len(self._buf) < need:
            try:
                self._buf.extend(await asyncio.wait_for(self._q.get(), timeout=self.FRAME_MS / 1000))
            except asyncio.TimeoutError:
                break

        if len(self._buf) >= need:
            chunk = bytes(self._buf[:need])
            del self._buf[:need]
            data = np.frombuffer(chunk, dtype="<i2")
        else:
            data = np.zeros(self._samples, dtype="int16")

        frame = av.AudioFrame.from_ndarray(data.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = self._sr
        frame.pts = self._timestamp
        frame.time_base = Fraction(1, self._sr)
        return frame
