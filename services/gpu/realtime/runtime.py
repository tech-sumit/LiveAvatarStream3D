"""Per-session realtime runtime.

Wires the conversational loop on the GPU node over the Cloudflare Realtime SFU.
The GPU never talks to the SFU directly; it drives it through the control-plane
``/rt/*`` routes (Wave 1). Two aiortc PeerConnections back the media plane:

  PC_pub  avatar audio+video (sendonly) -> POST /rt/publish -> SFU answer
  PC_sub  browser mic (recvonly)        -> POST /rt/subscribe (425-retry) ->
          answer + POST /rt/renegotiate -> on("track") -> STT

  STT -> POST /sessions/{id}/turn  (control plane runs the director LLM)
  control plane -> POST /sessions/{id}/dsl segments -> generation queue
  generation -> AvFrames -> PC_pub tracks

Barge-in: control plane posts {type:"cancel", epoch}; we bump the epoch, drop
the queue, and interrupt the in-flight generation so the avatar stops talking
immediately.

Heavy deps (aiortc, av) import lazily.
"""

from __future__ import annotations

import asyncio
import os

import httpx

from generate import RealtimeGenerator, AvFrame
from stt import SILENCE_MS

CONTROL_API = os.environ.get("CONTROL_API_URL", "http://localhost:8787")
INTERNAL_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "change-me")
SAMPLE_RATE = 16000

# Mic subscribe races the browser's publish: the SFU answers 425 until the
# browser's mic-audio track is live. A real first session waits on the browser's
# getUserMedia permission prompt + publish, which routinely exceeds 5s, so we
# retry with capped backoff for the session's lifetime (re-arm) rather than
# giving up forever. The backoff cap keeps this to one probe every couple of
# seconds — not a busy-spin.
SUBSCRIBE_BACKOFF_START_S = 0.25
SUBSCRIBE_BACKOFF_MAX_S = 2.0

# Auto-release a session whose WebRTC transport dies without an explicit stop
# (closed tab, network drop, crash). "failed"/"closed" on either PeerConnection
# is terminal and tears down at once; "disconnected" can be a transient blip, so
# it only tears down if it persists past this grace window (cancelled on
# recovery). Without this, a vanished browser leaks its session in _SESSIONS and
# strands the MuseTalk worker + GPU memory on the single node.
ICE_DISCONNECT_GRACE_S = 12.0

# Listening-pose hysteresis (expressive only). Raw webrtcvad capture state flips
# frame-to-frame at utterance boundaries; flipping the listening/idle base clip
# on every idle tick chatters. Require this many consecutive capturing ticks to
# ENTER the listening pose, then HOLD it for a short cooldown after capture stops
# so brief silences (and the endpoint transition) don't drop us back to idle.
LISTENING_ENTER_TICKS = 3
LISTENING_HOLD_S = 0.6


class SessionRuntime:
    def __init__(self, session_id: str, req: dict, generator: RealtimeGenerator):
        self.session_id = session_id
        self.req = req
        self.gen = generator
        self.epoch = 0
        self._seg_queue: asyncio.Queue = asyncio.Queue()
        # Separate media queues so the PC_pub audio and video tracks
        # consume independently (one shared queue would let one track starve the
        # other). Video carries full BGR frames; audio carries 16k PCM16 bytes.
        self._video_q: "asyncio.Queue" = asyncio.Queue(maxsize=240)
        self._audio_q: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=480)
        self._tasks: list[asyncio.Task] = []
        self._pc_pub = None
        self._pc_sub = None
        self._stt = None
        self._running = False
        self._stopping = False  # teardown started; reject new work, dedup stop()
        self._speaking = False  # a turn's segments are generating/playing
        self._audio_track = None  # AvatarAudioTrack, for barge-in buffer drain
        self._control_api = CONTROL_API
        self._ice_servers: list[dict] = []
        # Auto-release on transport death. on_release is set by the app layer to
        # remove this session from the app-level registry (mirroring the HTTP
        # /sessions/stop path); if unset we fall back to a bare self.stop().
        self.on_release = None  # set by app: Callable[[], Awaitable[None]]
        self._released = False  # self-release fired (idempotent guard)
        # State sources ("pub:conn", "sub:ice", ...) currently "disconnected".
        # The grace timer stays armed while any source is unhealthy.
        self._unhealthy: set[str] = set()
        self._grace_task: asyncio.Task | None = None
        self._release_task: asyncio.Task | None = None  # holds a ref so the GC can't drop it mid-flight
        # Debounced listening-pose state (expressive only; see _listening_pose).
        self._listening = False
        self._capture_run = 0
        self._listening_hold = 0
        self._listening_hold_max = max(1, int(LISTENING_HOLD_S * max(1, self.gen.tier.target_fps)))

    async def start(self, control_api_base: str, session_id: str, ice_servers: list[dict]) -> None:
        self.session_id = session_id
        self._control_api = control_api_base.rstrip("/")
        self._ice_servers = ice_servers
        # warm() loads MuseTalk + XTTS (tens of seconds, blocking); keep it off
        # the event loop so the publish callback and health stay responsive.
        await asyncio.get_running_loop().run_in_executor(None, self.gen.warm)
        self._running = True
        # Publish the avatar legs first so a subscribing browser sees the avatar
        # tracks immediately; then chase the browser mic in the background (it
        # 425-retries until the browser publishes, so it must not block start()).
        await self._publish()
        self._spawn(self._subscribe(), "subscribe")
        self._spawn(self._generation_loop(), "generation")
        self._spawn(self._idle_loop(), "idle")

    def _spawn(self, coro, name: str) -> asyncio.Task:
        """Create a background leg task whose exceptions are logged rather than
        silently swallowed by the GC ('Task exception never retrieved')."""
        task = asyncio.create_task(coro)

        def _done(t: asyncio.Task) -> None:
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                self._log(f"leg {name} crashed: {exc!r}")

        task.add_done_callback(_done)
        self._tasks.append(task)
        return task

    # --- SFU media plane (driven via control-plane /rt/* routes) ---

    def _rt_config(self):
        from aiortc import RTCConfiguration, RTCIceServer  # lazy

        servers = [RTCIceServer(**s) for s in self._ice_servers]
        if not servers:
            servers = [RTCIceServer(urls="stun:stun.cloudflare.com:3478")]
        return RTCConfiguration(iceServers=servers)

    async def _publish(self) -> None:
        """GPU PUBLISH: offer avatar audio+video sendonly, POST /rt/publish,
        apply the SFU answer. Push offers never renegotiate."""
        from aiortc import RTCPeerConnection, RTCSessionDescription  # lazy
        from tracks import (  # local
            AvatarVideoTrack,
            AvatarAudioTrack,
            prefer_codec,
            publish_tracks,
        )

        pc = RTCPeerConnection(self._rt_config())
        self._pc_pub = pc
        self._watch_ice(pc, "pub")

        self._audio_track = AvatarAudioTrack(self._audio_q, sample_rate=SAMPLE_RATE)
        audio_tx = pc.addTransceiver(self._audio_track, direction="sendonly")
        video_tx = pc.addTransceiver(
            AvatarVideoTrack(self._video_q, fps=self.gen.tier.target_fps), direction="sendonly"
        )
        prefer_codec(audio_tx, "audio", "audio/opus")
        prefer_codec(video_tx, "video", "video/VP8")

        await pc.setLocalDescription(await pc.createOffer())
        tracks = publish_tracks(audio_mid=audio_tx.mid, video_mid=video_tx.mid)
        self._log(f"publish offer mids audio={audio_tx.mid} video={video_tx.mid}")

        answer = await self._rt_post("publish", {"peer": "gpu", "sdp": pc.localDescription.sdp, "tracks": tracks})
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        self._log("publish answer applied")

    async def _subscribe(self) -> None:
        """GPU SUBSCRIBE: pull the browser mic. POST /rt/subscribe 425-retries
        until the browser publishes; on the SFU offer, answer + /rt/renegotiate,
        then feed the incoming mic track into STT."""
        from aiortc import RTCPeerConnection, RTCSessionDescription  # lazy
        from tracks import MIC_AUDIO  # local

        pc = RTCPeerConnection(self._rt_config())
        self._pc_sub = pc
        self._watch_ice(pc, "sub")

        @pc.on("track")
        def on_track(track):  # noqa: ANN001
            self._log(f"subscribe track kind={track.kind}")
            if track.kind == "audio":
                self._spawn(self._stt_loop(track), "stt")

        # Re-arm: probe /rt/subscribe with capped backoff for the session's
        # lifetime. The SFU 425s until the browser's mic is live, which depends
        # on the user accepting the getUserMedia prompt; we keep chasing it
        # (instead of giving up after a fixed budget) so a slow first join still
        # lands. Transient transport/HTTP errors are retried, not fatal.
        offer = None
        backoff = SUBSCRIBE_BACKOFF_START_S
        attempt = 0
        async with httpx.AsyncClient(timeout=15) as client:
            while self._running:
                attempt += 1
                try:
                    res = await client.post(
                        self._rt_url("subscribe"),
                        json={"peer": "gpu", "refs": [MIC_AUDIO]},
                        headers={"x-internal-token": INTERNAL_TOKEN},
                    )
                except httpx.HTTPError as exc:
                    self._log(f"subscribe transient error attempt {attempt}: {exc!r}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, SUBSCRIBE_BACKOFF_MAX_S)
                    continue
                if res.status_code == 425:
                    self._log(f"subscribe 425 (browser mic not live) attempt {attempt}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, SUBSCRIBE_BACKOFF_MAX_S)
                    continue
                if not res.is_success:
                    self._log(f"subscribe HTTP {res.status_code} attempt {attempt}; retrying")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, SUBSCRIBE_BACKOFF_MAX_S)
                    continue
                offer = res.json()
                break

        if offer is None:
            return  # session stopped before the browser mic ever published

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type="offer"))
        await pc.setLocalDescription(await pc.createAnswer())
        await self._rt_post("renegotiate", {"peer": "gpu", "sdp": pc.localDescription.sdp})
        self._log("subscribe negotiated; mic feeding STT")

    def _rt_url(self, action: str) -> str:
        return f"{self._control_api}/api/sessions/{self.session_id}/rt/{action}"

    async def _rt_post(self, action: str, body: dict) -> dict:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                self._rt_url(action),
                json=body,
                headers={"x-internal-token": INTERNAL_TOKEN},
            )
            res.raise_for_status()
            return res.json()

    def _watch_ice(self, pc, leg: str) -> None:
        @pc.on("connectionstatechange")
        async def _on_conn():  # noqa: ANN202
            state = pc.connectionState
            self._log(f"{leg} connectionState={state}")
            self._on_transport_state(f"{leg}:conn", state)

        @pc.on("iceconnectionstatechange")
        async def _on_ice():  # noqa: ANN202
            state = pc.iceConnectionState
            self._log(f"{leg} iceConnectionState={state}")
            self._on_transport_state(f"{leg}:ice", state)

    def _on_transport_state(self, source: str, state: str) -> None:
        """React to a pub/sub PeerConnection state transition for auto-release.

        Terminal states ("failed"/"closed") tear down immediately; a transient
        "disconnected" arms the grace timer and is cancelled if the transport
        recovers ("connected"/"completed"). No-op once teardown has started so we
        don't fight the explicit stop() path (its pc.close() emits "closed")."""
        if self._stopping or self._released:
            return
        if state in ("failed", "closed"):
            self._schedule_release(f"{source} -> {state}")
        elif state == "disconnected":
            self._unhealthy.add(source)
            self._arm_grace()
        elif state in ("connected", "completed"):
            self._unhealthy.discard(source)
            if not self._unhealthy:
                self._cancel_grace()

    def _arm_grace(self) -> None:
        if self._grace_task is not None and not self._grace_task.done():
            return
        self._grace_task = asyncio.create_task(self._grace_then_release())

    async def _grace_then_release(self) -> None:
        try:
            await asyncio.sleep(ICE_DISCONNECT_GRACE_S)
        except asyncio.CancelledError:
            return
        # The transport recovered (set cleared) or teardown already began: bail.
        if self._stopping or self._released or not self._unhealthy:
            return
        await self._self_release("ice disconnected beyond grace")

    def _cancel_grace(self) -> None:
        if self._grace_task is not None and not self._grace_task.done():
            self._grace_task.cancel()
        self._grace_task = None

    def _schedule_release(self, reason: str) -> None:
        # Run the (awaitable) release off the event handler so the handler
        # returns promptly; _self_release is idempotent via _released.
        if self._release_task is not None and not self._release_task.done():
            return
        self._release_task = asyncio.create_task(self._self_release(reason))

    async def _self_release(self, reason: str) -> None:
        if self._stopping or self._released:
            return
        self._released = True
        self._log(f"auto-release ({reason})")
        # Prefer the app-level callback so the session also leaves _SESSIONS /
        # _WORKDIRS (so /health sessions drops and the node frees up); it invokes
        # self.stop() internally. Fall back to a bare stop() if unwired.
        cb = self.on_release
        if cb is not None:
            await cb()
        else:
            await self.stop()

    def _log(self, msg: str) -> None:
        print(f"[rt {self.session_id}] {msg}", flush=True)

    # --- STT -> turn ---

    async def _stt_loop(self, track) -> None:
        from stt import StreamingSTT

        loop = asyncio.get_running_loop()

        def on_final(text: str) -> None:
            asyncio.run_coroutine_threadsafe(self._post_turn(text), loop)

        self._stt = StreamingSTT(on_final=on_final, model=self.gen.stt_model)
        resampler = _make_resampler()
        carry = bytearray()  # sub-20ms remainder kept across frames
        while self._running:
            try:
                frame = await track.recv()
            except Exception:
                break
            # Resample/convert frame to 16k mono PCM16 in 20ms chunks.
            chunks = _frame_to_pcm20(frame, resampler, carry)
            if not chunks:
                continue
            # push() runs webrtcvad and, at an endpoint, the blocking GPU
            # transcribe. Marshal it to a worker thread so the event loop keeps
            # servicing the avatar audio/video recv() during transcription
            # (on_final hops back via run_coroutine_threadsafe). recv() stays
            # responsive, so no avatar stutter at endpoints.
            await loop.run_in_executor(None, self._push_chunks, chunks)

    def _push_chunks(self, chunks: list[bytes]) -> None:
        for pcm in chunks:
            self._stt.push(pcm)

    async def _post_turn(self, text: str) -> None:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{self._control_api}/api/sessions/{self.session_id}/turn",
                json={"text": text},
                headers={"x-internal-token": INTERNAL_TOKEN},
            )

    # --- DSL ingest (from control plane SessionDO) ---

    async def ingest(self, message: dict) -> None:
        if self._stopping:
            return  # teardown in progress: drop late DSL/cancel, don't re-arm work
        kind = message.get("type")
        if kind == "cancel":
            # Epoch is monotonic (only ever advanced by barge-in/teardown). Two
            # superseding cancels can have their control fetches land out of
            # order; clamp to the max so a late e+1 can't rewind us below e+2 and
            # silently drop the newest turn's segments.
            self.epoch = max(self.epoch, int(message.get("epoch", self.epoch + 1)))
            _drain(self._seg_queue)
            _drain(self._video_q)  # stop current speech immediately (barge-in)
            _drain(self._audio_q)
            if self._audio_track is not None:
                # The audio track may hold a residual partial 20ms frame; clear
                # it so barge-in doesn't bleed a stale fragment into the next turn.
                self._audio_track.drain()
            # Barge-in cut the avatar mid-speech: drop any armed clip crossfade so
            # the next turn doesn't blend from a frame no longer on screen.
            # Expressive-only; the flag-OFF cancel path is unchanged.
            if self.gen.expressive:
                self.gen.reset_continuity()
            self._speaking = False
        elif kind == "segment":
            segment = message.get("segment")
            if not isinstance(segment, dict) or not segment.get("text"):
                self._log(f"ingest dropped malformed segment: {segment!r}")
                return
            await self._seg_queue.put((message.get("epoch", self.epoch), segment))

    async def _generation_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while self._running:
            epoch, segment = await self._seg_queue.get()
            if epoch != self.epoch:
                continue  # stale (superseded by barge-in)
            self._speaking = True
            try:
                # generate() runs MuseTalk + XTTS (blocking, GPU); pump it from a
                # worker thread so the event loop (SFU, STT) stays responsive, and
                # bail out promptly on barge-in.
                it = await loop.run_in_executor(None, lambda: iter(self.gen.generate(segment)))
                while epoch == self.epoch:
                    av = await loop.run_in_executor(None, lambda it=it: next(it, None))
                    if av is None:
                        break
                    # Re-check the epoch right before enqueueing: a barge-in can
                    # bump it while next() was running, and we must not push a
                    # frame into a queue that was just drained.
                    if epoch != self.epoch:
                        break
                    if av.image_bgr is not None:
                        await self._video_q.put(av)
                    if av.pcm16:
                        await self._audio_q.put(av.pcm16)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                # One segment failing must not tear down the whole leg — that
                # would silently brick every later turn. Log and move on so the
                # next turn's segments still generate.
                self._log(f"generation error on segment (skipped): {exc!r}")
            finally:
                # End-of-turn only when no further segments are pending; mid-turn
                # gaps between segments keep _speaking set so idle frames don't
                # splice into the utterance.
                if self._seg_queue.empty():
                    self._speaking = False

    def _user_capturing(self) -> bool:
        """True while the STT is mid-capture of the user's utterance: speech has
        been buffered and the trailing-silence endpoint hasn't fired yet.

        Reads the StreamingSTT's capture state directly (stt.py owns that state
        and is frozen for this slice). _buf clears + _silence_ms resets on
        _finalize(), so this falls back to False between turns. The read races
        the executor thread that feeds the STT, but only a single length/int are
        inspected and the worst case is a one-frame-late pose flip."""
        stt = self._stt
        return stt is not None and len(stt._buf) > 0 and stt._silence_ms < SILENCE_MS

    def _listening_pose(self) -> bool:
        """Debounced listening-vs-idle decision for the expressive ambient pose.

        Wraps the raw, chattery ``_user_capturing()`` with hysteresis: enter the
        listening pose only after ``LISTENING_ENTER_TICKS`` consecutive capturing
        ticks, then hold it through brief silences for ``_listening_hold_max``
        ticks after capture stops. The pose therefore switches at real utterance
        boundaries instead of every webrtcvad flip. Expressive-only — never
        reached on the flag-OFF path (the caller short-circuits on
        ``gen.expressive``)."""
        if self._user_capturing():
            self._capture_run += 1
            if self._capture_run >= LISTENING_ENTER_TICKS:
                self._listening = True
                self._listening_hold = self._listening_hold_max
        else:
            self._capture_run = 0
            if self._listening:
                if self._listening_hold > 0:
                    self._listening_hold -= 1
                else:
                    self._listening = False
        return self._listening

    async def _idle_loop(self) -> None:
        # Publish ambient (non-speech) frames only when genuinely between turns.
        # Gating on _speaking (not just queue emptiness) prevents ambient
        # (mouth-closed) frames from interleaving with mid-turn MuseTalk bursts,
        # which would flicker + desync lips. The audio_q check covers the tail of
        # a turn whose video has drained but whose audio is still playing out.
        #
        # Expressive: while the user is actively talking to us (STT capturing),
        # hold the attentive `listening` pose instead of the static idle cycle;
        # otherwise idle. With expressive OFF this is byte-for-byte today's path:
        # always gen.idle_frame().
        while self._running:
            if (
                not self._speaking
                and self._video_q.empty()
                and self._audio_q.empty()
                and self._seg_queue.empty()
            ):
                if self.gen.expressive and self._listening_pose():
                    idle = self.gen.ambient_frame("listening")
                else:
                    idle = self.gen.idle_frame()
                if idle.image_bgr is not None:
                    try:
                        self._video_q.put_nowait(idle)
                    except asyncio.QueueFull:
                        pass
            await asyncio.sleep(1 / max(1, self.gen.tier.target_fps))

    async def stop(self) -> None:
        """Forceful, prompt, idempotent teardown (must finish well under the
        control plane's 5s stopSession bound, even mid-generation)."""
        if self._stopping:
            return  # idempotent: a duplicate stop is a safe no-op
        self._stopping = True
        self._running = False
        # Drop any pending disconnect grace timer; we're tearing down anyway.
        self._cancel_grace()
        # Bump the epoch and drop every queue so the generation loop and any
        # in-flight ingest treat all pending/queued work as stale immediately.
        self.epoch += 1
        _drain(self._seg_queue)
        _drain(self._video_q)
        _drain(self._audio_q)

        for t in self._tasks:
            t.cancel()

        # Kill the MuseTalk worker FIRST. The generation task is almost certainly
        # parked in a run_in_executor MuseTalk step(), and executor futures aren't
        # cancellable — the task cannot observe its own cancellation until that
        # blocking step returns. Killing the worker subprocess closes its stdout
        # (EOF), so the in-flight step errors out at once and the cancelled task
        # can finish, instead of running the MuseTalk pass to its 300s timeout
        # (which is what blew past the control plane's stop bound and leaked the
        # node, leaving a stranded worker holding GPU memory).
        try:
            self.gen.close()
        except Exception:  # noqa: BLE001
            pass

        # Bounded wait: give the cancelled legs a moment to unwind now that the
        # executor work is unblocked, but never block teardown on a straggler.
        # The executor thread itself isn't awaitable; once the worker is dead it
        # errors out and is abandoned (the thread pool reclaims it).
        if self._tasks:
            await asyncio.wait(self._tasks, timeout=2.0)
        self._tasks = []

        # Close both PeerConnections regardless of how the legs unwound.
        for pc in (self._pc_pub, self._pc_sub):
            if pc is not None:
                try:
                    await pc.close()
                except Exception:  # noqa: BLE001
                    pass
        self._pc_pub = None
        self._pc_sub = None


def _drain(q: asyncio.Queue) -> None:
    while not q.empty():
        try:
            q.get_nowait()
        except Exception:
            break


_PCM20_BYTES = int(SAMPLE_RATE * 0.02) * 2  # one 20ms 16k mono PCM16 frame (640 bytes)


def _make_resampler():
    """A real 16k mono s16 resampler (libswresample via PyAV).

    Browser Opus arrives at 48kHz (often stereo); webrtcvad and faster-whisper
    require 16k mono PCM16. A persistent resampler preserves swr history across
    frames so the conversion is gapless rather than per-frame independent.
    """
    from av.audio.resampler import AudioResampler  # lazy (heavy media dep)

    return AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)


def _frame_to_pcm20(frame, resampler, carry: bytearray) -> list[bytes]:
    """Resample one aiortc audio frame to 16k mono PCM16 and return whole 20ms
    frames. Any sub-frame remainder is held in ``carry`` for the next call so the
    20ms chunk boundaries webrtcvad/Whisper need stay exact at any input rate."""
    import numpy as np

    try:
        resampled = resampler.resample(frame)
    except Exception:
        return []
    if not isinstance(resampled, (list, tuple)):
        resampled = [resampled] if resampled is not None else []
    for rf in resampled:
        arr = np.ascontiguousarray(rf.to_ndarray()).reshape(-1).astype("<i2")
        carry.extend(arr.tobytes())
    chunks: list[bytes] = []
    while len(carry) >= _PCM20_BYTES:
        chunks.append(bytes(carry[:_PCM20_BYTES]))
        del carry[:_PCM20_BYTES]
    return chunks
