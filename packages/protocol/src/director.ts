import { z } from 'zod';
import { EMOTIONS, GESTURES, POSTURES, StreamedSegment } from './dsl.js';

/**
 * The director-LLM contract. The director turns a user turn (realtime) or a
 * plain prompt (offline LLM-assist) into the performance DSL. It must emit
 * segments using ONLY the enumerated vocabularies so the GPU layer can map
 * them to model conditioning deterministically.
 */

export const DirectorMode = z.enum(['stream', 'draft']);
export type DirectorMode = z.infer<typeof DirectorMode>;

export const DirectorRequest = z.object({
  sessionId: z.string().optional(),
  mode: DirectorMode,
  /** Persona / behavior instructions for the avatar. */
  persona: z.string().default(''),
  /** Conversation history (realtime) or the single prompt (draft). */
  userTurn: z.string(),
  /** Prior turns for context, oldest first. */
  history: z
    .array(z.object({ role: z.enum(['user', 'avatar']), text: z.string() }))
    .default([]),
  language: z.string().default('en'),
});
export type DirectorRequest = z.infer<typeof DirectorRequest>;

/** A chunk of the director's streamed response. */
export const DirectorStreamChunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('segment'), segment: StreamedSegment }),
  z.object({ type: z.literal('done'), turnId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type DirectorStreamChunk = z.infer<typeof DirectorStreamChunk>;

/**
 * The system prompt that constrains the LLM to emit valid DSL. Kept here so the
 * control plane and any offline tooling share one source of truth.
 */
export function buildDirectorSystemPrompt(persona: string): string {
  return [
    'You are the director of a realtime digital avatar. You decide what the',
    'avatar says and how it performs each beat. Respond ONLY as a stream of',
    'JSON objects, one per line (JSONL), each matching this shape:',
    '{ "seq": <int>, "turnId": "<id>", "text": "<words>",',
    `  "emotion": one of [${EMOTIONS.join(', ')}],`,
    `  "gesture": one of [${GESTURES.join(', ')}],`,
    `  "posture": one of [${POSTURES.join(', ')}],`,
    '  "emphasis": [<words from text>], "pause_ms_after": <int ms>,',
    '  "final": <true on the last segment> }',
    'Keep each segment to one short spoken sentence so it can be streamed and',
    'performed immediately. Do not output markdown, prose, or any text outside',
    'the JSONL objects.',
    'Perform expressively: do not leave the avatar static. Let "emotion" track the',
    'meaning of each beat and shift it across a turn rather than repeating one value,',
    'and add a fitting "gesture" (and occasional "posture" change) on beats that',
    'warrant emphasis instead of defaulting everything to "none"/"neutral". Match',
    'these to the content and persona; do not perform at random.',
    'On the avatar\'s very first beat of a conversation (no prior avatar turns),',
    'open with a brief greeting using "gesture": "wave" and a warm "emotion".',
    persona ? `\nAvatar persona / behavior:\n${persona}` : '',
  ].join('\n');
}
