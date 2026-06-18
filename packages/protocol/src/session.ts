import { z } from 'zod';

/** Realtime session lifecycle, coordinated by SessionDO. */
export const SessionStatus = z.enum([
  'allocating', // waiting for a warm GPU node
  'connecting', // WebRTC negotiation
  'live',
  'ended',
  'failed',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const RealtimeSession = z.object({
  id: z.string(),
  userId: z.string(),
  avatarId: z.string(),
  voiceId: z.string(),
  status: SessionStatus,
  persona: z.string().default(''),
  /** Assigned GPU node / pod id from the warm pool. */
  gpuNode: z.string().optional(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().optional(),
});
export type RealtimeSession = z.infer<typeof RealtimeSession>;

export const StartSessionRequest = z.object({
  userId: z.string(),
  avatarId: z.string(),
  voiceId: z.string(),
  persona: z.string().default(''),
  tier: z.enum(['fast', 'premium']).default('fast'),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequest>;

export const IceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

/** Realtime SFU session info handed to clients. Clients drive the SFU via the
 *  control-plane /rt/* routes (publish/subscribe/renegotiate); no WHIP/WHEP. */
export const SessionMedia = z.object({
  sessionId: z.string(),
  /** Cloudflare Realtime (Calls) app id. */
  realtimeAppId: z.string(),
  iceServers: z.array(IceServer).default([]),
});
export type SessionMedia = z.infer<typeof SessionMedia>;

/** Stable track names exchanged across the SFU. The avatar (GPU) publishes
 *  `avatar-audio` + `avatar-video`; the browser publishes `mic-audio`. */
export const RT_TRACKS = {
  avatarAudio: 'avatar-audio',
  avatarVideo: 'avatar-video',
  micAudio: 'mic-audio',
} as const;

/** Control messages over the session data channel / websocket. */
export const SessionControl = z.discriminatedUnion('type', [
  z.object({ type: z.literal('barge_in') }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('end') }),
]);
export type SessionControl = z.infer<typeof SessionControl>;

/** Where a user turn originated: spoken (post-STT) or typed in the browser. */
export const TurnSource = z.enum(['voice', 'text']);
export type TurnSource = z.infer<typeof TurnSource>;

/** Hard upper bound on a single user turn's text. Shared by the `/turn` edge
 *  route and the SessionDO so the token-less browser path can't drive an
 *  unbounded LLM/GPU prompt. STT (voice) turns are well under this. */
export const MAX_TURN_TEXT_CHARS = 4000;

/** Server→client events broadcast over the control websocket so the browser can
 *  render a live chat transcript alongside the WebRTC media. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_turn'), text: z.string(), source: TurnSource }),
  z.object({ type: z.literal('avatar_reply'), text: z.string(), final: z.boolean() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Parse an inbound server event, returning `null` on malformed input rather
 *  than throwing — callers handle these off untrusted socket frames. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  const parsed = ServerEvent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
