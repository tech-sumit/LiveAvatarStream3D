import { z } from 'zod';
import { StreamedSegment } from './dsl.js';
import { GestureKind, EmotionPreset, ShotSize } from './score.js';

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
 * The system prompt that constrains the LLM to emit a valid {@link Score} (the
 * Phase 5 Score runtime). The director now emits ONE Score object — a script plus
 * per-beat cues that reference NAMED Stage refs and use NAMED presets (emotion /
 * shot size / gesture kind) rather than raw numbers — so direction is data the
 * compiler turns into a Performance. Kept here so the control plane and any offline
 * tooling share one source of truth.
 */
export function buildDirectorSystemPrompt(persona: string, stageId = 'studio'): string {
  return [
    'You are the director of a realtime digital avatar. You decide what the avatar',
    'says AND how it performs, and you emit a single JSON "Score" object (no prose,',
    'no markdown, no text outside the JSON). The Score is compiled into a rendered',
    'performance, so it MUST validate against this shape:',
    '',
    `{ "stage": "${stageId}",`,
    '  "defaults": { "emotion": <emotion preset>, "gait": "walk"|"stride" },   // optional',
    '  "beats": [ {',
    '    "text": "<one short spoken sentence>",',
    '    "emotion": <emotion preset>,            // optional; preset NAME, never numbers',
    '    "emphasis": ["<words from text>"],       // optional',
    '    "pauseMsAfter": <int ms>,                // optional',
    '    "cues": [ /* zero or more, see below */ ]',
    '  } ] }',
    '',
    'Each cue is ONE of these objects (optionally prefixed with "at": { "word": <int index into the beat text> }):',
    '  { "gesture": { "kind": <gesture kind>, "target": "<ref>"?, "hand": "auto"|"left"|"right"?, "count": <int>?, "hold": <sec>?, "amount": <0..1>? } }',
    '  { "emote": { "emotion": <emotion preset>, "intensity": <0..1>? } }',
    '  { "look": { "at": "<ref>" } }',
    '  { "turn": { "to": "<ref>" | <yaw radians> } }',
    '  { "move": { "to": "<ref>", "gait": "walk"|"stride"?, "speed": <number>? } }',
    '  { "camera": { "frame": { "subjects": ["<ref>", ...], "size": <shot size>? }, "follow": <bool>? } }',
    '  { "camera": { "shot": "<savedShot id>" } }',
    '  { "camera": { "move": "dolly"|"orbit"|"pan"|"truck"|"pedestal", "amount": <number>, "ease": "linear"|"ease_in"|"ease_out"|"ease_in_out"? } }',
    '',
    `Allowed emotion presets: [${EmotionPreset.options.join(', ')}].`,
    `Allowed gesture kinds: [${GestureKind.options.join(', ')}].`,
    `Allowed camera shot sizes: [${ShotSize.options.join(', ')}].`,
    'A "ref" is a NAMED Stage mark/target (e.g. "center", "screen") or one of',
    '"self.face" / "self.chest" / "self.root". Prefer named refs and presets;',
    'NEVER invent raw camera coordinates — frame by subjects + a size preset.',
    '',
    'Perform expressively: do not leave the avatar static. Let "emotion" track the',
    'meaning of each beat and shift it across the turn rather than repeating one value;',
    'add a fitting "gesture" cue on beats that warrant emphasis instead of leaving every',
    'beat bare. Match the direction to the content and persona; do not perform at random.',
    'On the avatar\'s very first beat (no prior avatar turns), open with a brief greeting',
    'whose first cue is { "gesture": { "kind": "wave" } } and a warm "emotion".',
    persona ? `\nAvatar persona / behavior:\n${persona}` : '',
  ].join('\n');
}
