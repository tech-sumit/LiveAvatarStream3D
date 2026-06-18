"""Streaming speech-to-text with VAD endpointing (faster-whisper).

Feeds 20ms PCM frames; emits a finalized transcript when ~800ms of trailing
silence is detected (matches the conversational turn-taking budget). A partial
hook lets the caller start the director early (speculative).
"""

from __future__ import annotations

from collections import deque
from typing import Callable, Optional

SAMPLE_RATE = 16000
FRAME_MS = 20
SILENCE_MS = 800


def load_model(model_size: str = "small.en"):
    """Construct the faster-whisper model used by StreamingSTT (CUDA, fp16).

    Exposed so the session can pre-load + CUDA-warm the model at warm() time and
    hand the same instance to StreamingSTT, erasing the first-turn STT cold cliff.
    """
    from faster_whisper import WhisperModel  # lazy (heavy CUDA dep)

    return WhisperModel(model_size, device="cuda", compute_type="float16")


class StreamingSTT:
    def __init__(
        self,
        on_final: Callable[[str], None],
        on_partial: Optional[Callable[[str], None]] = None,
        model_size: str = "small.en",
        model=None,
    ):
        self.on_final = on_final
        self.on_partial = on_partial
        self._model_size = model_size
        self._model = model
        self._buf = bytearray()
        self._silence_ms = 0
        self._vad = None
        self._recent = deque(maxlen=50)

    def _ensure(self):
        if self._model is None:
            self._model = load_model(self._model_size)
        if self._vad is None:
            import webrtcvad  # lazy

            self._vad = webrtcvad.Vad(2)

    def push(self, pcm16: bytes) -> None:
        """Push one 20ms frame of 16k mono PCM16."""
        self._ensure()
        is_speech = self._vad.is_speech(pcm16, SAMPLE_RATE)
        self._buf.extend(pcm16)
        if is_speech:
            self._silence_ms = 0
        else:
            self._silence_ms += FRAME_MS
            if self._silence_ms >= SILENCE_MS and len(self._buf) > SAMPLE_RATE:  # >1s of audio
                self._finalize()

    def _finalize(self) -> None:
        import numpy as np

        audio = np.frombuffer(bytes(self._buf), dtype=np.int16).astype("float32") / 32768.0
        self._buf.clear()
        self._silence_ms = 0
        segments, _ = self._model.transcribe(audio, language="en", beam_size=1)
        text = " ".join(s.text for s in segments).strip()
        if text:
            self.on_final(text)
