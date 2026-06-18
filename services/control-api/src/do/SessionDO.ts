import {
  buildDirectorSystemPrompt,
  MAX_TURN_TEXT_CHARS,
  RT_TRACKS,
  SessionControl,
  StreamedSegment,
  TurnSource,
  type StartSessionRequest,
  type SessionMedia,
  type ServerEvent,
} from '@las/protocol';
import type { Env } from '../env.js';
import { makeGpuProvider, type SessionAllocation } from '../gpu/provider.js';
import { makeDirector } from '../director.js';
import {
  mintTurnCredentials,
  createCfSession,
  addLocalTracks,
  addRemoteTracks,
  renegotiate,
  closeSession,
  type LocalTrack,
  type TrackKind,
} from '../realtime.js';
import { newId } from '../lib/ids.js';

type RtPeerSlot = 'gpuPub' | 'gpuSub' | 'browserPub' | 'browserSub';

interface RtPeer {
  cfSessionId: string;
  published: boolean;
  // `mid` is retained so teardown can close tracks (the SFU close endpoint is
  // mid-keyed); Wave 2 clients only ever see trackName + kind.
  tracks: { trackName: string; kind: TrackKind; mid: string }[];
}

interface RtState {
  gpuPub?: RtPeer;
  gpuSub?: RtPeer;
  browserPub?: RtPeer;
  browserSub?: RtPeer;
}

const RT_SLOTS = ['gpuPub', 'gpuSub', 'browserPub', 'browserSub'] as const;

/**
 * Conversation state. Persisted under the `state` storage key. The SFU peer
 * sessions live under a SEPARATE `rt` key (see `RtState`) so the multi-second
 * director turn loop and the /rt broker never write the same record: a
 * publish/subscribe landing mid-turn can no longer be clobbered by the turn's
 * trailing whole-object write.
 */
interface SessionState {
  id: string;
  req: StartSessionRequest;
  alloc?: SessionAllocation;
  /** Where the GPU worker ingests streamed DSL segments. */
  ingestUrl?: string;
  history: { role: 'user' | 'avatar'; text: string }[];
  /** Bumped on barge-in to cancel an in-flight director stream. */
  turnEpoch: number;
}

const STATE_KEY = 'state';
const RT_KEY = 'rt';
const ENDED_KEY = 'ended';

// Teardown ceilings. The GPU release is the load-bearing cleanup so it gets the
// larger budget; each SFU close is short and runs concurrently. Both are well
// under the client DELETE timeout so a single hung dependency can't strand the
// whole teardown.
const STOP_SESSION_TIMEOUT_MS = 5000;
const CF_CLOSE_TIMEOUT_MS = 5000;

// Per-session turn governance. The browser drives `/turn` with only the
// (unguessable) sessionId — no token — so these bound how fast and how many
// director/GPU turns a single session can fan out. The voice/STT path is
// naturally paced by speech, so only the rate floor is text-specific.
const MIN_TEXT_TURN_INTERVAL_MS = 750;
const MAX_PENDING_TURNS = 4;
// Bound on control websockets retained per session so a reconnect storm can't
// grow `this.control` without limit. The newest socket is the live client, so
// when over the cap the oldest retained socket is evicted.
const MAX_CONTROL_SOCKETS = 8;

/** Resolve/reject `p`, but reject after `ms` if it hasn't settled. The timer is
 *  always cleared so a settled race doesn't leave a dangling reject pending. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type RtPeer2Peer = 'gpu' | 'browser';

interface RtPublishBody {
  peer: RtPeer2Peer;
  sdp: string;
  tracks: { mid: string; trackName: string; kind: TrackKind }[];
}

interface RtSubscribeBody {
  peer: RtPeer2Peer;
  refs: string[];
}

interface RtRenegotiateBody {
  peer: RtPeer2Peer;
  sdp: string;
}

/**
 * Realtime session coordinator. Allocates a warm GPU node, owns conversation
 * state, runs the director LLM, and streams DSL segments to the GPU worker.
 * Handles barge-in by bumping a turn epoch so the in-flight stream aborts.
 */
export class SessionDO {
  private control = new Set<WebSocket>();

  // Dedupes genuinely-concurrent end() calls (control-WS {type:'end'} racing a
  // client DELETE) within this DO instance. The DO is single-instance globally,
  // so this in-memory guard fully covers concurrency without a persisted
  // one-shot flag that would strand the GPU if the first attempt hung.
  private endInFlight?: Promise<void>;

  // Turn serialization. The DO is single-instance globally, so an in-memory lock
  // fully serializes the director-streaming critical section: only one turn's
  // DSL stream is ever active, so concurrent turns (a typed turn landing
  // mid-reply) can't interleave segments to the GPU or corrupt `history`.
  private turnLock: Promise<void> = Promise.resolve();
  // Monotonic id of every accepted turn + the id of the most recent one. A turn
  // that finds itself no longer the latest by the time it owns the lock is
  // dropped (newest user input wins), so intermediate turns never reach the LLM.
  private turnSeq = 0;
  private latestTurn = 0;
  // Active + queued turns, used to cap fan-out and to decide whether a newly
  // arriving turn must supersede an in-flight one.
  private pendingTurns = 0;
  private lastTextTurnAt = 0;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/start' && req.method === 'POST') {
      const body = (await req.json()) as StartSessionRequest;
      try {
        const media = await this.start(body);
        return Response.json(media);
      } catch (err) {
        // A throw here is overwhelmingly a non-2xx from the GPU realtime node
        // (down/restarting/saturated). Surface it as a clean, retryable 503 so
        // the route can distinguish "node unavailable" from a real bug rather
        // than turning it into an opaque 500.
        console.warn(`session start failed: ${err}`);
        return new Response(
          JSON.stringify({ error: 'avatar node is warming or unavailable, please retry' }),
          { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5' } },
        );
      }
    }

    // Browser control channel (barge-in / mute / end).
    if (url.pathname === '/control') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      // Evict the oldest retained socket(s) before adding the new one so a
      // client that reconnects repeatedly (without its stale sockets firing
      // 'close') can't grow `this.control` without bound. Sets preserve
      // insertion order, so the first entry is the oldest.
      while (this.control.size >= MAX_CONTROL_SOCKETS) {
        const oldest = this.control.values().next().value;
        if (!oldest) break;
        this.control.delete(oldest);
        try {
          oldest.close();
        } catch {
          // already closing/closed
        }
      }
      this.control.add(server);
      server.addEventListener('message', (ev) => this.onControl(String(ev.data)));
      server.addEventListener('close', () => this.control.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    // A finalized user turn: the GPU worker posts spoken turns (post-STT,
    // source defaults to 'voice'); the browser posts typed turns (source 'text').
    if (url.pathname === '/turn' && req.method === 'POST') {
      const body = (await req.json()) as { text?: unknown; source?: unknown };
      const source: TurnSource = TurnSource.safeParse(body.source).success
        ? (body.source as TurnSource)
        : 'voice';
      const text = typeof body.text === 'string' ? body.text : '';

      // Defense in depth behind the edge route: empty/oversized turns are
      // rejected, the token-less text path is rate-floored, and total fan-out is
      // capped so one session can't spawn an unbounded LLM/GPU turn storm.
      if (text.trim().length === 0 || text.length > MAX_TURN_TEXT_CHARS) {
        return Response.json({ error: 'invalid turn text' }, { status: 400 });
      }
      const now = Date.now();
      if (source === 'text' && now - this.lastTextTurnAt < MIN_TEXT_TURN_INTERVAL_MS) {
        return Response.json(
          { error: 'too many turns' },
          { status: 429, headers: { 'retry-after': '1' } },
        );
      }
      if (this.pendingTurns >= MAX_PENDING_TURNS) {
        return Response.json(
          { error: 'too many turns in flight' },
          { status: 429, headers: { 'retry-after': '1' } },
        );
      }
      if (source === 'text') this.lastTextTurnAt = now;

      await this.handleTurn(text, source);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/end' && req.method === 'POST') {
      await this.end();
      return Response.json({ ok: true });
    }

    // Realtime SFU control plane: publish / subscribe / renegotiate.
    if (url.pathname === '/rt/publish' && req.method === 'POST') {
      return this.rtPublish((await req.json()) as RtPublishBody);
    }
    if (url.pathname === '/rt/subscribe' && req.method === 'POST') {
      return this.rtSubscribe((await req.json()) as RtSubscribeBody);
    }
    if (url.pathname === '/rt/renegotiate' && req.method === 'POST') {
      return this.rtRenegotiate((await req.json()) as RtRenegotiateBody);
    }

    return new Response('not found', { status: 404 });
  }

  private pubSlot(peer: RtPeer2Peer): RtPeerSlot {
    return peer === 'gpu' ? 'gpuPub' : 'browserPub';
  }

  private subSlot(peer: RtPeer2Peer): RtPeerSlot {
    return peer === 'gpu' ? 'gpuSub' : 'browserSub';
  }

  /** Lazily create the SFU session backing a peer slot, guarding against
   *  concurrent first-calls so a slot is never double-created. Reads and writes
   *  only the `rt` key (re-read inside the guard); never touches `state`. */
  private async ensurePeer(slot: RtPeerSlot): Promise<RtPeer> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!(await this.getState())) throw new Error('session not started');
      const rt = await this.getRt();
      const existing = rt[slot];
      if (existing) return existing;
      const cfSessionId = await createCfSession(this.env);
      const peer: RtPeer = { cfSessionId, published: false, tracks: [] };
      rt[slot] = peer;
      await this.ctx.storage.put(RT_KEY, rt);
      return peer;
    });
  }

  private async rtPublish(body: RtPublishBody): Promise<Response> {
    const slot = this.pubSlot(body.peer);
    const peer = await this.ensurePeer(slot);
    const tracks: LocalTrack[] = body.tracks.map((t) => ({
      mid: t.mid,
      trackName: t.trackName,
      kind: t.kind,
    }));
    const { answerSdp } = await addLocalTracks(this.env, peer.cfSessionId, body.sdp, tracks);
    // Persist published state with a short read-modify-write of the rt key.
    const committed = await this.ctx.blockConcurrencyWhile(async () => {
      const rt = await this.getRt();
      const p = rt[slot];
      if (!p) return false;
      p.published = true;
      p.tracks = body.tracks.map((t) => ({ trackName: t.trackName, kind: t.kind, mid: t.mid }));
      await this.ctx.storage.put(RT_KEY, rt);
      return true;
    });
    if (!committed) {
      return new Response(JSON.stringify({ error: 'session ended' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    return Response.json({ sdp: answerSdp });
  }

  private async rtSubscribe(body: RtSubscribeBody): Promise<Response> {
    if (!(await this.getState())) return new Response(null, { status: 404 });
    const rt = await this.getRt();

    // Resolve each requested track to its publisher peer by stable track name.
    const resolved: { sessionId: string; trackName: string }[] = [];
    for (const trackName of body.refs) {
      let pub: RtPeer | undefined;
      if (trackName === RT_TRACKS.micAudio) {
        pub = rt.browserPub;
      } else if (trackName === RT_TRACKS.avatarAudio || trackName === RT_TRACKS.avatarVideo) {
        pub = rt.gpuPub;
      } else {
        return new Response(JSON.stringify({ error: `unknown track ${trackName}` }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!pub || !pub.published) {
        // Publisher not live yet — tell the caller to retry shortly.
        return new Response(null, { status: 425 });
      }
      resolved.push({ sessionId: pub.cfSessionId, trackName });
    }

    const slot = this.subSlot(body.peer);
    const sub = await this.ensurePeer(slot);
    const { offerSdp, tracks } = await addRemoteTracks(this.env, sub.cfSessionId, resolved);
    return Response.json({ sdp: offerSdp, tracks });
  }

  private async rtRenegotiate(body: RtRenegotiateBody): Promise<Response> {
    const rt = await this.getRt();
    const sub = rt[this.subSlot(body.peer)];
    if (!sub) return new Response(null, { status: 409 });
    await renegotiate(this.env, sub.cfSessionId, body.sdp);
    return Response.json({ ok: true });
  }

  private async getState(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>(STATE_KEY);
  }

  private async getRt(): Promise<RtState> {
    return (await this.ctx.storage.get<RtState>(RT_KEY)) ?? {};
  }

  private async start(req: StartSessionRequest): Promise<SessionMedia> {
    const id = newId('sess');
    const provider = makeGpuProvider(this.env);

    // Cloudflare TURN credentials for NAT traversal. SFU peer sessions are
    // created lazily on the first /rt/publish or /rt/subscribe call.
    const iceServers = await mintTurnCredentials(this.env);

    // Allocate the GPU node and hand it the ICE servers it needs.
    const alloc = await provider.startSession(id, req, { iceServers });

    const state: SessionState = {
      id,
      req,
      alloc,
      ingestUrl: `${provider.serviceUrl('realtime')}/sessions/${id}/dsl`,
      history: [],
      turnEpoch: 0,
    };
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.put(RT_KEY, {} as RtState);
    return {
      sessionId: id,
      realtimeAppId: this.env.CF_REALTIME_APP_ID,
      iceServers,
    };
  }

  /** Push a server event to every connected browser control socket. Closed or
   *  erroring sockets are dropped so a dead client can't break the broadcast. */
  private broadcast(evt: ServerEvent): void {
    const payload = JSON.stringify(evt);
    for (const ws of this.control) {
      try {
        ws.send(payload);
      } catch {
        this.control.delete(ws);
      }
    }
  }

  private onControl(raw: string): void {
    let msg: SessionControl;
    try {
      msg = SessionControl.parse(JSON.parse(raw));
    } catch {
      return; // ignore malformed control
    }
    switch (msg.type) {
      case 'barge_in':
        void this.bargeIn();
        return;
      case 'mute':
        // The browser also mutes locally via track.enabled; nothing to do
        // server-side. Logged so the control path isn't silently dropped.
        console.log(`session control: mute=${msg.muted}`);
        return;
      case 'end':
        void this.end();
        return;
      default: {
        const _exhaustive: never = msg;
        return _exhaustive;
      }
    }
  }

  private async bargeIn(): Promise<void> {
    // Short read-modify-write of the `state` key; the LLM stream is never held
    // across this guard, and `rt` lives under its own key so a concurrent
    // publish/subscribe is unaffected.
    const cancel = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.getState();
      if (!state) return undefined;
      state.turnEpoch += 1; // cancels any in-flight director stream
      await this.ctx.storage.put(STATE_KEY, state);
      return { epoch: state.turnEpoch, ingestUrl: state.ingestUrl };
    });
    // Tell the GPU worker to drop queued audio/video immediately.
    if (cancel?.ingestUrl) {
      await fetch(cancel.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.env.INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({ type: 'cancel', epoch: cancel.epoch }),
      }).catch(() => undefined);
    }
  }

  /**
   * Accept a finalized user turn and serialize it against any in-flight turn.
   *
   * Strategy (consistent with the existing barge-in / `turnEpoch` design):
   * "newest turn wins". A turn arriving while another is streaming supersedes it
   * — we bump the epoch exactly as a barge-in does so the active stream aborts at
   * its next chunk boundary and the GPU drops queued audio. We then serialize on
   * an in-memory lock so the two director streams never overlap. Any turn that
   * is no longer the latest by the time it owns the lock is dropped, so a burst
   * of typed turns collapses to a single LLM/GPU turn rather than a backlog. The
   * lock guarantees `history` is appended atomically and in order.
   */
  private async handleTurn(userText: string, source: TurnSource): Promise<void> {
    const myTurn = ++this.turnSeq;
    const superseding = this.pendingTurns > 0;
    this.latestTurn = myTurn;
    this.pendingTurns++;
    try {
      // Cancel the actively-streaming turn (if any) before queuing behind the
      // lock, so it aborts promptly instead of running to completion first.
      if (superseding) await this.bargeIn();
      await this.withTurnLock(async () => {
        // A newer turn arrived while we waited for the lock — drop this one so
        // only the latest user input reaches the director.
        if (myTurn !== this.latestTurn) return;
        await this.runTurn(userText, source);
      });
    } finally {
      this.pendingTurns--;
    }
  }

  /** Run `fn` with exclusive ownership of the turn lock. Reassigns the tail
   *  synchronously so concurrent callers chain in arrival order; a prior turn's
   *  rejection never poisons the chain. */
  private async withTurnLock(fn: () => Promise<void>): Promise<void> {
    const prior = this.turnLock;
    let release!: () => void;
    this.turnLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
    } catch {
      // a previous turn threw; the lock is still ours to take
    }
    try {
      await fn();
    } finally {
      release();
    }
  }

  /** Director loop: stream DSL segments for the user's turn to the GPU worker,
   *  mirroring the turn to browser transcript subscribers as it streams. */
  private async runTurn(userText: string, source: TurnSource): Promise<void> {
    const state = await this.getState();
    if (!state || !state.ingestUrl) return;
    const ingestUrl = state.ingestUrl;
    const epoch = state.turnEpoch;
    const turnId = newId('turn');
    const historyForLlm = [...state.history, { role: 'user' as const, text: userText }];

    this.broadcast({ type: 'user_turn', text: userText, source });

    const director = makeDirector(this.env);
    const system = buildDirectorSystemPrompt(state.req.persona);
    let buf = '';
    let seq = 0;
    let avatarText = '';

    for await (const chunk of director.streamRaw(system, userText, historyForLlm)) {
      // Abort if a barge-in bumped the epoch — and never broadcast a stale reply.
      const cur = await this.getState();
      if (!cur || cur.turnEpoch !== epoch) return;

      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const seg = this.parseSegment(line, turnId, seq);
        if (seg) {
          seq++;
          avatarText += ` ${seg.text}`;
          await this.sendSegment(ingestUrl, seg, epoch);
          this.broadcast({ type: 'avatar_reply', text: avatarText.trim(), final: false });
        }
      }
    }
    const last = this.parseSegment(buf, turnId, seq, true);
    if (last) {
      avatarText += ` ${last.text}`;
      await this.sendSegment(ingestUrl, last, epoch);
    }

    // Persist the completed turn with a short read-modify-write that preserves
    // the latest turnEpoch — a barge-in landing after the stream finished must
    // not be clobbered, and the conversation `state` key is never held across
    // the LLM stream above. Only emit the final transcript reply if this turn
    // is still the current one.
    const committed = await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.getState();
      if (!cur || cur.turnEpoch !== epoch) return false;
      cur.history.push({ role: 'user', text: userText });
      cur.history.push({ role: 'avatar', text: avatarText.trim() });
      await this.ctx.storage.put(STATE_KEY, cur);
      return true;
    });
    if (committed) this.broadcast({ type: 'avatar_reply', text: avatarText.trim(), final: true });
  }

  private parseSegment(
    line: string,
    turnId: string,
    seq: number,
    final = false,
  ): StreamedSegment | null {
    const t = line.trim().replace(/^```(json)?|```$/g, '').trim();
    if (!t.startsWith('{')) return null;
    try {
      const obj = JSON.parse(t);
      return StreamedSegment.parse({ ...obj, seq, turnId, final: obj.final ?? final });
    } catch {
      return null;
    }
  }

  private async sendSegment(ingestUrl: string, seg: StreamedSegment, epoch: number): Promise<void> {
    await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': this.env.INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify({ type: 'segment', epoch, segment: seg }),
    }).catch(() => undefined);
  }

  private async end(): Promise<void> {
    // Concurrent double-end collapses onto a single in-flight teardown. The
    // promise is cleared once settled so that if teardown did NOT fully release
    // the GPU (a hung stopSession), a later idempotent DELETE retry re-runs it
    // instead of short-circuiting to a no-op 200 that leaks the node.
    if (this.endInFlight) return this.endInFlight;
    this.endInFlight = this.runEnd();
    try {
      await this.endInFlight;
    } finally {
      this.endInFlight = undefined;
    }
  }

  private async runEnd(): Promise<void> {
    // A prior teardown that actually released the GPU set `ended` (last, after
    // wiping storage), making this a safe no-op. A prior teardown that hung or
    // timed out never set it, so we fall through and re-attempt — the retry
    // path that guarantees the GPU node is eventually released.
    if (await this.ctx.storage.get<boolean>(ENDED_KEY)) return;

    const rt = await this.getRt();
    const state = await this.getState();

    // 1. Release the GPU node FIRST and independently of the SFU closes — this
    //    is the load-bearing cleanup and must never be stranded behind a hung
    //    CF close. Bounded so a slow/unresponsive pod can't block teardown.
    //    Whether it actually completed gates the one-shot `ended` flag below.
    let gpuReleased = true;
    if (state?.alloc) {
      const provider = makeGpuProvider(this.env);
      gpuReleased = await withTimeout(
        provider.stopSession(state.alloc.node, state.id),
        STOP_SESSION_TIMEOUT_MS,
        'gpu stopSession',
      )
        .then(() => true)
        .catch((err) => {
          console.warn(`session end: gpu stopSession failed/timed out: ${err}`);
          return false;
        });
    }

    // 2. Release every SFU session we lazily created — all four slots,
    //    regardless of `published`. `ensurePeer` mints a CF session as soon as
    //    any slot is touched (incl. subs, and pubs whose addLocalTracks later
    //    threw), so iterating only the published pubs would orphan the rest.
    //    Run them concurrently and bound each: one hung CF close can't block
    //    teardown, and failures/timeouts are swallowed (logged), never thrown.
    await Promise.allSettled(
      RT_SLOTS.map(async (slot) => {
        const peer = rt[slot];
        if (!peer) return;
        try {
          await withTimeout(
            closeSession(this.env, peer.cfSessionId),
            CF_CLOSE_TIMEOUT_MS,
            `cf closeSession ${slot}`,
          );
        } catch (err) {
          console.warn(`session end: cf closeSession ${slot} failed/timed out: ${err}`);
        }
      }),
    );

    for (const ws of this.control) ws.close();
    this.control.clear();

    // 3. Commit the one-shot guard ONLY if the GPU was actually released. Wipe
    //    storage first, then set `ended` as the surviving marker so a retry
    //    short-circuits. If stopSession timed out, leave storage intact so the
    //    idempotent DELETE retry re-runs teardown and releases the node.
    if (gpuReleased) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(ENDED_KEY, true);
    }
  }
}
