import { describe, it, expect } from 'vitest';
import {
  parseScriptLine,
  selectTalkClip,
  gestureClipFor,
  GESTURE_NAMES,
  EMOTION_NAMES,
  type Gesture,
} from './gestures.js';

// ─────────────────────────────────────────────────────────────────────────────
// gestures.ts characterization suite — the studio's authoring FRONT DOOR.
//
// parseScriptLine turns a raw script line into { text, gesture, emotion } for the
// live Speak path and the narration build; the tag vocabularies are DERIVED from
// @las/protocol enums. These tests pin the CURRENT parsing behavior (tag
// extraction, precedence, stripping, keyword inference, and the malformed-bracket
// edge cases) so the Score/Stage redesign can refactor this file without silently
// changing how existing scripts read. No DOM/THREE — the module is pure.
// ─────────────────────────────────────────────────────────────────────────────

describe('script-tag vocabularies (derived from @las/protocol)', () => {
  it('GESTURE_NAMES is the deduped snake_case tag set in enum order', () => {
    // Pinned: present/openPalms collapse onto open_palms, clasp/handToChest onto
    // hand_to_chest, IK + talk-base kinds keep their kind name. If protocol adds a
    // GestureKind, this pin flags that the editor's "known tag" set changed.
    expect([...GESTURE_NAMES]).toEqual([
      'none',
      'wave',
      'point',
      'open_palms',
      'count',
      'hand_to_chest',
      'nod',
      'thumbs_up',
      'shrug',
      'explain',
    ]);
  });

  it('EMOTION_NAMES mirrors the protocol EmotionPreset enum verbatim', () => {
    expect([...EMOTION_NAMES]).toEqual([
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
    ]);
  });
});

describe('parseScriptLine — explicit [tag] extraction', () => {
  it('extracts a gesture tag and strips it from the spoken text', () => {
    const r = parseScriptLine('[wave] Hello viewers.');
    expect(r).toEqual({ text: 'Hello viewers.', gesture: 'wave', emotion: undefined });
  });

  it('extracts an emotion tag; gesture then falls back to keyword inference', () => {
    // 'look' is a point keyword — the emotion tag must not swallow the inference.
    const r = parseScriptLine('[serious] Take a look at the chart.');
    expect(r.emotion).toBe('serious');
    expect(r.gesture).toBe('point');
    expect(r.text).toBe('Take a look at the chart.');
  });

  it('accepts gesture+emotion tags in either order', () => {
    expect(parseScriptLine('[excited][wave] And finally!')).toEqual({
      text: 'And finally!',
      gesture: 'wave',
      emotion: 'excited',
    });
    expect(parseScriptLine('[wave][excited] And finally!')).toEqual({
      text: 'And finally!',
      gesture: 'wave',
      emotion: 'excited',
    });
  });

  it('first gesture tag wins; later gesture tags are ignored (but still stripped)', () => {
    const r = parseScriptLine('[wave][shrug] Fine.');
    expect(r.gesture).toBe('wave');
    expect(r.text).toBe('Fine.');
  });

  it('first emotion tag wins; later emotion tags are ignored (but still stripped)', () => {
    const r = parseScriptLine('[happy][sad] The news tonight.');
    expect(r.emotion).toBe('happy');
    expect(r.text).toBe('The news tonight.');
  });

  it('tags are case-insensitive', () => {
    const r = parseScriptLine('[SHRUG] Fine then.');
    expect(r.gesture).toBe('shrug');
    expect(r.text).toBe('Fine then.');
  });

  it('an explicit tag beats keyword inference', () => {
    // 'Hello' would infer wave; the explicit [shrug] must win.
    expect(parseScriptLine('[shrug] Hello everyone.').gesture).toBe('shrug');
  });

  it('a mid-sentence tag is stripped and the whitespace collapses to one space', () => {
    // 'Good evening' is a wave keyword — the explicit [nod] must still win.
    const r = parseScriptLine('Good evening. [nod] Stay tuned.');
    expect(r.text).toBe('Good evening. Stay tuned.');
    expect(r.gesture).toBe('nod');
  });

  it('unknown tags are ignored for parsing but STILL stripped from the text', () => {
    // Pinned: the strip regex removes every [a-z_]+ bracket, known or not, so a
    // typo'd tag never leaks into the TTS text.
    const r = parseScriptLine('[backflip] Stand by for more.');
    expect(r.text).toBe('Stand by for more.');
    expect(r.gesture).toBe('explain');
    expect(r.emotion).toBeUndefined();
  });

  it('an unknown tag does not block a later known tag', () => {
    expect(parseScriptLine('[backflip][wave] Onward.').gesture).toBe('wave');
  });

  it('snake_case tags resolve to camelCase GestureKinds', () => {
    expect(parseScriptLine('[thumbs_up] Nicely done.').gesture).toBe('thumbsUp');
    expect(parseScriptLine('[none] Silence.').gesture).toBe('none');
  });

  it('shared tags resolve to the FIRST kind in protocol enum order', () => {
    // Pinned: open_palms is shared by present/openPalms and hand_to_chest by
    // clasp/handToChest; the parser returns the first enum member (present, clasp)
    // — NOT the kind the keyword heuristics use (openPalms, handToChest). Both
    // aliases map to the same clip via GESTURE_KIND_TO_CLIP, so downstream renders
    // identically, but the returned KIND is the alias pinned here.
    expect(parseScriptLine('[open_palms] Ready.').gesture).toBe('present');
    expect(parseScriptLine('[hand_to_chest] Ready.').gesture).toBe('clasp');
  });
});

describe('parseScriptLine — keyword inference (no explicit gesture tag)', () => {
  // One representative line per KEYWORDS row, each chosen so no EARLIER row matches.
  const CASES: [string, Gesture][] = [
    ['Hello and welcome, everyone.', 'wave'], // greeting row wins over 'everyone' (openPalms)
    ['Take a look at the chart.', 'point'],
    ['Everyone, join us now.', 'openPalms'],
    ['First, the markets.', 'count'],
    ['Simply amazing results.', 'thumbsUp'],
    ['Maybe it will pass.', 'shrug'],
    ['I believe in our team.', 'handToChest'],
  ];
  for (const [line, gesture] of CASES) {
    it(`"${line}" infers ${gesture}`, () => {
      expect(parseScriptLine(line).gesture).toBe(gesture);
    });
  }

  it('keyword rows are checked in order — the first matching row wins', () => {
    // 'hello' (wave, row 1) beats 'everyone' (openPalms, row 3).
    expect(parseScriptLine('Hello everyone.').gesture).toBe('wave');
  });

  it('a line with no keywords falls back to explain (plain talking)', () => {
    const r = parseScriptLine('The quarterly report was published today.');
    expect(r.gesture).toBe('explain');
    expect(r.emotion).toBeUndefined();
  });
});

describe('parseScriptLine — empty / whitespace / malformed input', () => {
  it('an empty line yields empty text and the explain fallback', () => {
    expect(parseScriptLine('')).toEqual({ text: '', gesture: 'explain', emotion: undefined });
  });

  it('a whitespace-only line trims to empty text', () => {
    expect(parseScriptLine('   \t ')).toEqual({ text: '', gesture: 'explain', emotion: undefined });
  });

  it('a line that is only a tag yields empty text', () => {
    expect(parseScriptLine('[happy]')).toEqual({ text: '', gesture: 'explain', emotion: 'happy' });
  });

  it('an unclosed bracket is not a tag — it stays in the text verbatim', () => {
    const r = parseScriptLine('[shrug Stand still.');
    expect(r.text).toBe('[shrug Stand still.');
    expect(r.gesture).toBe('explain');
  });

  it('empty brackets [] are not a tag and are not stripped', () => {
    expect(parseScriptLine('weird [] brackets').text).toBe('weird [] brackets');
  });

  it('brackets containing spaces or digits are not tags and are not stripped', () => {
    // The tag charset is strictly [a-z_]+ — "[open palms]" and "[take2]" pass through.
    expect(parseScriptLine('[open palms] ready').text).toBe('[open palms] ready');
    expect(parseScriptLine('[take2] rolling').text).toBe('[take2] rolling');
  });
});

describe('gestureClipFor — kind → one-shot clip/trigger', () => {
  it('maps every GestureKind to its pinned clip (or null for talk-base kinds)', () => {
    // Pinned: the full casing seam — library kinds → snake_case clips, IK kinds →
    // their trigger names ('point'/'count'), talk-base kinds → null (no overlay).
    const EXPECTED: Record<Gesture, string | null> = {
      none: null,
      explain: null,
      point: 'point',
      count: 'count',
      wave: 'wave',
      present: 'open_palms',
      openPalms: 'open_palms',
      thumbsUp: 'thumbs_up',
      shrug: 'shrug',
      handToChest: 'hand_to_chest',
      clasp: 'hand_to_chest',
      nod: 'nod',
    };
    for (const [kind, clip] of Object.entries(EXPECTED)) {
      expect(gestureClipFor(kind as Gesture), kind).toBe(clip);
    }
  });
});

describe('selectTalkClip — energy-bucket talk-base rotation (pure)', () => {
  it('high-energy emotions rotate through talk3/talk4/talk5, skipping the last clip', () => {
    // lastClip 'talk3' filters the pool to [talk4, talk5]; seq indexes into it.
    expect(selectTalkClip('excited', 'talk3', 0)).toBe('talk4');
    expect(selectTalkClip('excited', 'talk3', 1)).toBe('talk5');
    expect(selectTalkClip('excited', 'talk3', 2)).toBe('talk4'); // wraps
  });

  it('med-energy (neutral) rotates through talk1/talk2/talk3', () => {
    expect(selectTalkClip('neutral', '', 0)).toBe('talk1');
    expect(selectTalkClip('neutral', 'talk1', 0)).toBe('talk2');
  });

  it('low-energy (serious) draws from idle_calm/talk1', () => {
    expect(selectTalkClip('serious', '', 0)).toBe('idle_calm');
    expect(selectTalkClip('serious', '', 1)).toBe('talk1');
  });

  it('never repeats lastClip when the bucket has an alternative', () => {
    for (let seq = 0; seq < 6; seq++) {
      expect(selectTalkClip('excited', 'talk4', seq)).not.toBe('talk4');
      expect(selectTalkClip('neutral', 'talk2', seq)).not.toBe('talk2');
    }
  });

  it('calm=true holds the base to the LOW pool regardless of emotional energy', () => {
    // A calm anchor must not throw wide arms (talk4/5) even on an excited beat.
    expect(selectTalkClip('excited', '', 0, true)).toBe('idle_calm');
    expect(selectTalkClip('excited', 'idle_calm', 3, true)).toBe('talk1');
  });

  it('is pure: identical (emotion, lastClip, seq) always picks the same clip', () => {
    // The former module-global rotation counter is gone; live and export must pick
    // the SAME sequence from the same caller-owned seq.
    const a = selectTalkClip('happy', 'talk4', 7);
    const b = selectTalkClip('happy', 'talk4', 7);
    expect(a).toBe(b);
  });
});
