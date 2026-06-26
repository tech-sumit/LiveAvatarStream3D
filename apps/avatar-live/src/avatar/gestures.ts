import { GestureKind, EmotionPreset, GESTURE_KIND_TO_CLIP, EMOTION_ENERGY } from '@las/protocol';
import type { GestureKind as Gesture, EmotionPreset as EmotionName } from '@las/protocol';
import { resolveGesture } from '@las/performer-core';

// The gesture/emotion vocabulary, talk-clip selection, and the script-line parser.
//
// The gesture VOCAB now lives in @las/protocol (the camelCase `GestureKind` enum); the
// snake_case on-disk clip filenames are reached ONLY through protocol's
// `GESTURE_KIND_TO_CLIP` (the single casing seam), and the gesture descriptor (clip vs
// IK vs none) + energy come from performer-core's pure `resolveGesture`. The former
// `GESTURE_CLIPS`/`SPECIFIC`/`KEYWORDS`/`ENERGY`/`BUCKETS` tables and the module-global
// `rotation` counter are gone — talk-clip selection is a pure function of a caller-owned
// sequence index (no hidden state that could diverge live vs export).
//
// `Gesture` is re-exported (= protocol's camelCase `GestureKind`) so performer.ts keeps a
// single gesture type for the speak/export paths; `EmotionName` (= protocol's
// `EmotionPreset`) is the same union as avatar/emotion.ts's, so callers keep using theirs.
export type { Gesture };

// ── Script-tag vocabulary (snake_case, user-facing) ──────────────────────────
// The script editor highlights a tag as "known" iff the parser acts on it. Both
// vocabularies are DERIVED from the protocol enums so they can never drift:
//  - emotions are already lowercase, used verbatim;
//  - gestures map each camelCase `GestureKind` to its snake_case tag form — the clip
//    filename for library gestures (`openPalms` → `open_palms`), or the kind itself for
//    the IK / talk-base kinds (`point`/`count`/`none`/`explain`). `present`/`clasp`
//    collapse onto `open_palms`/`hand_to_chest`, so this yields exactly the historical
//    snake_case tag set (no behavior change to existing scripts).
function tagForKind(kind: Gesture): string {
  return GESTURE_KIND_TO_CLIP[kind] ?? kind;
}

// camelCase GestureKind ↔ snake_case script tag. Built once from the protocol enum.
const KIND_TO_TAG: Record<Gesture, string> = Object.fromEntries(
  GestureKind.options.map((k) => [k, tagForKind(k)]),
) as Record<Gesture, string>;

// snake_case tag → the canonical camelCase GestureKind. When two kinds share a tag
// (present/openPalms → open_palms, clasp/handToChest → hand_to_chest), the FIRST kind in
// the enum order wins — matching the historical `GESTURE_CLIPS` key resolution.
const TAG_TO_KIND: Record<string, Gesture> = (() => {
  const m: Record<string, Gesture> = {};
  for (const k of GestureKind.options) {
    const tag = KIND_TO_TAG[k];
    if (!(tag in m)) m[tag] = k;
  }
  return m;
})();

// The recognized gesture tags (snake_case) — deduped, deterministic enum order.
export const GESTURE_NAMES: readonly string[] = GestureKind.options
  .map((k) => KIND_TO_TAG[k])
  .filter((tag, i, arr) => arr.indexOf(tag) === i);

// Emotion directive tags — straight from the protocol enum (already lowercase).
export const EMOTION_NAMES: readonly string[] = [...EmotionPreset.options];

const GESTURES = new Set<string>(GESTURE_NAMES);
const EMOTIONS = new Set<string>(EMOTION_NAMES);

// Keyword → gesture heuristics, applied when a line has no explicit [tag]. The mapped
// kinds are camelCase `GestureKind`s; the keyword sets are unchanged from before.
const KEYWORDS: [RegExp, Gesture][] = [
  [/\b(hi|hello|hey|welcome|greetings|good (morning|evening|afternoon)|goodbye|bye)\b/i, 'wave'],
  [/\b(look|here|there|this|that|see|notice|behind me|over here)\b/i, 'point'],
  [/\b(everyone|all of you|together|both|everybody|join)\b/i, 'openPalms'],
  [/\b(first|second|third|one|two|three|several|many|number)\b/i, 'count'],
  [/\b(great|amazing|awesome|excellent|fantastic|love it|perfect|well done)\b/i, 'thumbsUp'],
  [/\b(maybe|not sure|perhaps|who knows|whatever|i guess|don'?t know)\b/i, 'shrug'],
  [/\b(i think|i believe|honestly|personally|i feel|in my view|i'?m)\b/i, 'handToChest'],
];

// ── Talk-animation selection ─────────────────────────────────────────────────
// A spoken segment plays a talking-base clip chosen from an energy bucket driven by the
// segment's emotion (via protocol's EMOTION_ENERGY), rotating so consecutive segments
// don't reuse the same clip (avoids a robotic loop). A dedicated gesture clip (if any)
// plays once OVER this base — see {@link gestureClipFor} + avatarController.playGesture.
//
// These are avatar-live clip ASSETS (which clips exist on disk), not a DSL vocabulary, so
// they stay here; the energy CLASSIFICATION moved to protocol (EMOTION_ENERGY). The
// pools below are the former `BUCKETS`, renamed for clarity.
const TALK_BUCKETS: Record<'low' | 'med' | 'high', string[]> = {
  low: ['idle_calm', 'talk1'],
  med: ['talk1', 'talk2', 'talk3'],
  high: ['talk3', 'talk4', 'talk5'],
};

/**
 * The dedicated one-shot clip/trigger for a gesture kind, or null when it's plain talking
 * (`none`/`explain`) — then no gesture overlay plays, just the base clip.
 *
 * Routed through performer-core's `resolveGesture`: a library gesture returns its
 * snake_case clip; the IK kinds return their loaded trigger clip (`point` walks the anchor
 * to the screen, `count` plays the count clip + procedural finger pose — both detected by
 * avatarController.playGesture) so the historical point/count behavior is preserved.
 */
export function gestureClipFor(kind: Gesture): string | null {
  const drive = resolveGesture(kind);
  if (drive.kind === 'clip') return drive.clip ?? null;
  if (drive.kind === 'ik') return drive.ik === 'count' ? 'count' : 'point';
  return null; // 'none' / 'explain' → no overlay, just the talk base
}

/**
 * Pick the BASE talking-body clip for a spoken segment by emotional energy, skipping the
 * last clip so it visibly varies. PURE: `seq` is a caller-owned, monotonically-increasing
 * index (the former module-global `rotation`), so live and export pick the SAME clip
 * sequence — no hidden module state that could diverge between the two drive paths.
 */
export function selectTalkClip(emotion: EmotionName, lastClip: string, seq: number): string {
  const bucket = TALK_BUCKETS[EMOTION_ENERGY[emotion] ?? 'med'];
  const choices = bucket.filter((c) => c !== lastClip);
  const pool = choices.length ? choices : bucket;
  return pool[seq % pool.length] ?? bucket[0] ?? 'talk1';
}

/**
 * Parse inline stage directions from a script line and return the spoken text with the
 * directive tags removed, plus the resolved gesture KIND (camelCase) and emotion. Supports
 * gesture AND emotion tags, e.g.:
 *   "[serious] Good evening. [point] Tonight's lead story."
 *   "[excited][wave] And finally, great news!"
 * Explicit tags win; if no gesture tag, a gesture is inferred from keywords.
 *
 * (Formerly `resolveGesture` — renamed to `parseScriptLine` since it is a parser, not the
 * gesture-descriptor resolver. The live Speak path / narration build still depend on this
 * keyword inference to turn raw free-text into drives; authored Scores bypass it.)
 */
export function parseScriptLine(raw: string): { text: string; gesture: Gesture; emotion?: EmotionName } {
  let gesture: Gesture | null = null;
  let emotion: EmotionName | undefined;
  for (const tag of raw.match(/\[([a-z_]+)\]/gi) ?? []) {
    const name = tag.slice(1, -1).toLowerCase();
    if (!gesture && GESTURES.has(name)) gesture = TAG_TO_KIND[name] ?? null;
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
