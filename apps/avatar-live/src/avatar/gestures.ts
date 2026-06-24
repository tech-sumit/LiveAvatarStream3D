import type { EmotionName } from './emotion.js';

// DSL gesture vocabulary (mirrors packages/protocol dsl.ts) and how each maps to
// a body-animation clip + how to infer one from a line of script.
export type Gesture =
  | 'none'
  | 'wave'
  | 'point'
  | 'open_palms'
  | 'count'
  | 'thumbs_up'
  | 'nod'
  | 'shrug'
  | 'hand_to_chest'
  | 'explain';

// Each specific gesture has its OWN dedicated mocap clip (RPM Standing-Expression
// mocap, fetched by scripts/fetch-animations.sh). These play once over the talking
// motion and settle back (see avatarController.playGesture). 'none'/'explain' have
// no dedicated gesture — they just talk, so they map to idle/talk fallbacks.
export const GESTURE_CLIPS: Record<Gesture, string> = {
  none: 'idle_calm',
  explain: 'talk1',
  open_palms: 'open_palms',
  point: 'point',
  count: 'count',
  wave: 'wave',
  thumbs_up: 'thumbs_up',
  shrug: 'shrug',
  hand_to_chest: 'hand_to_chest',
  nod: 'nod',
};

// The gesture-tag vocabulary the script parser recognizes — derived from the clip
// map so it can never drift. Exported so the script editor highlights exactly the
// tags this parser acts on (a tag is "known" iff it's in here / EMOTION_NAMES).
export const GESTURE_NAMES: readonly string[] = Object.keys(GESTURE_CLIPS);
const GESTURES = new Set<string>(GESTURE_NAMES);

// Keyword → gesture heuristics, applied when a line has no explicit [tag].
const KEYWORDS: [RegExp, Gesture][] = [
  [/\b(hi|hello|hey|welcome|greetings|good (morning|evening|afternoon)|goodbye|bye)\b/i, 'wave'],
  [/\b(look|here|there|this|that|see|notice|behind me|over here)\b/i, 'point'],
  [/\b(everyone|all of you|together|both|everybody|join)\b/i, 'open_palms'],
  [/\b(first|second|third|one|two|three|several|many|number)\b/i, 'count'],
  [/\b(great|amazing|awesome|excellent|fantastic|love it|perfect|well done)\b/i, 'thumbs_up'],
  [/\b(maybe|not sure|perhaps|who knows|whatever|i guess|don'?t know)\b/i, 'shrug'],
  [/\b(i think|i believe|honestly|personally|i feel|in my view|i'?m)\b/i, 'hand_to_chest'],
];

// ── Talk-animation selection ─────────────────────────────────────────────────
// Specific gestures play their dedicated clip; otherwise we choose a talking
// variation from an energy bucket driven by the segment's emotion, rotating so
// consecutive segments don't reuse the same clip (avoids a robotic loop).
const SPECIFIC = new Set<Gesture>([
  'wave',
  'point',
  'open_palms',
  'count',
  'thumbs_up',
  'shrug',
  'hand_to_chest',
  'nod',
]);

const ENERGY: Record<EmotionName, 'low' | 'med' | 'high'> = {
  neutral: 'med',
  warm: 'med',
  confident: 'med',
  happy: 'high',
  excited: 'high',
  surprised: 'high',
  serious: 'low',
  concerned: 'low',
  sad: 'low',
  thoughtful: 'low',
};

// Talking-variation clips grouped by how animated they are.
const BUCKETS: Record<'low' | 'med' | 'high', string[]> = {
  low: ['idle_calm', 'talk1'],
  med: ['talk1', 'talk2', 'talk3'],
  high: ['talk3', 'talk4', 'talk5'],
};

let rotation = 0;

/** The dedicated one-shot gesture clip for a gesture, or null when it's plain
 *  talking ('none'/'explain') — then no gesture overlay plays, just the base clip. */
export function gestureClipFor(gesture: Gesture): string | null {
  return SPECIFIC.has(gesture) ? GESTURE_CLIPS[gesture] : null;
}

/**
 * Pick the BASE talking-body clip for a spoken segment by emotional energy,
 * skipping the last clip so it visibly varies. A dedicated gesture (if any) plays
 * once OVER this base — see {@link gestureClipFor} + avatarController.playGesture.
 */
export function selectTalkClip(_gesture: Gesture, emotion: EmotionName, lastClip: string): string {
  const bucket = BUCKETS[ENERGY[emotion] ?? 'med'];
  const choices = bucket.filter((c) => c !== lastClip);
  const pick = (choices.length ? choices : bucket)[rotation % (choices.length || bucket.length)];
  rotation++;
  return pick;
}

// Emotion directive vocabulary (mirrors EmotionName / DSL emotions). Exported so
// the script editor highlights exactly the emotion tags this parser recognizes.
export const EMOTION_NAMES: readonly string[] = [
  'neutral',
  'warm',
  'happy',
  'excited',
  'serious',
  'concerned',
  'sad',
  'confident',
  'thoughtful',
  'surprised',
];
const EMOTIONS = new Set<string>(EMOTION_NAMES);

/**
 * Parse inline stage directions from a script line and return the spoken text
 * with the directive tags removed. Supports gesture AND emotion tags, e.g.:
 *   "[serious] Good evening. [point] Tonight's lead story."
 *   "[excited][wave] And finally, great news!"
 * Explicit tags win; if no gesture tag, a gesture is inferred from keywords.
 */
export function resolveGesture(raw: string): { text: string; gesture: Gesture; emotion?: EmotionName } {
  let gesture: Gesture | null = null;
  let emotion: EmotionName | undefined;
  for (const tag of raw.match(/\[([a-z_]+)\]/gi) ?? []) {
    const name = tag.slice(1, -1).toLowerCase();
    if (!gesture && GESTURES.has(name)) gesture = name as Gesture;
    else if (!emotion && EMOTIONS.has(name)) emotion = name as EmotionName;
  }
  const text = raw.replace(/\[[a-z_]+\]/gi, '').replace(/\s+/g, ' ').trim();

  if (!gesture) {
    for (const [re, g] of KEYWORDS) {
      if (re.test(text)) {
        gesture = g;
        break;
      }
    }
  }
  return { text, gesture: gesture ?? 'explain', emotion };
}
