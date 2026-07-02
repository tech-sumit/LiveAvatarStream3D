import { describe, it, expect } from 'vitest';
import { compileScore, validateScore, validateNewsReportDoc } from '@las/protocol';
import type { Stage, AudioTimings, AudioCue, Performance } from '@las/protocol';
import { createDispatcher, type BridgeControllers } from './dispatch.js';

// ─────────────────────────────────────────────────────────────────────────────
// g4 — Studio Bridge dispatch regression suite.
//
// These pin the three g4 findings against the bridge's newscast path WITHOUT any
// DOM/THREE/AudioContext: the validate/apply commands touch only @las/protocol +
// the injected controllers, so faithful fakes (a stub `dom`, a stub `importScore`
// that runs the REAL compileScore, a recording `timeline`/`voices`) exercise the
// exact threading the real studio uses.
//   [0] a legacy NewsReportDoc's music bed + SFX survive onto Performance.audio.
//   [1] applyNewscast repopulates the studio (script, narration cues, voice, name).
//   [2] validateNewscast on a near-valid NewsReportDoc reports the news error.
// ─────────────────────────────────────────────────────────────────────────────

// A legacy NewsReportDoc with BOTH a defaults.music bed and a section SFX cue.
const NEWSCAST = {
  version: 2,
  meta: {
    title: 'Evening Edition',
    anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice-xyz' }],
  },
  defaults: { emotion: 'neutral', music: { src: '/samples/bed.mp3', volume: 0.2 } },
  rundown: [
    { id: 's1', slug: 'intro', beats: [{ id: 'b1', text: 'Good evening and welcome to the broadcast.', gesture: 'wave', emotion: 'warm' }] },
    {
      id: 's2',
      slug: 'markets',
      beats: [{ id: 'b2', text: 'Markets rose today across the board.' }],
      audio: [{ id: 'sfx1', kind: 'sfx', src: '/sfx/whoosh.mp3', start: 0.5, duration: 1 }],
    },
  ],
};

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface SelectStub {
  value: string;
  options: { value: string }[];
  dispatchEvent(e: Event): boolean;
}
function selectStub(values: string[] = []): SelectStub {
  return { value: '', options: values.map((value) => ({ value })), dispatchEvent: () => true };
}
function inputStub(): { value: string; dispatchEvent(e: Event): boolean } {
  return { value: '', dispatchEvent: () => true };
}

function makeApp(voices: string[] = ['voice-xyz']) {
  const dom = {
    scriptEl: inputStub(),
    voiceSel: selectStub(voices),
    projectNameEl: inputStub(),
  };
  const logs: string[] = [];
  return { app: { dom, log: (m: string) => logs.push(m) } as unknown as Parameters<typeof createDispatcher>[0], dom, logs };
}

interface ImportCall {
  score: unknown;
  stage: Stage;
  timings: AudioTimings;
  audio?: AudioCue[];
}
interface NarrationCall {
  cues: { track: string; text?: string; src?: string; label?: string }[];
  totalSec: number;
}

function makeControllers() {
  const importCalls: ImportCall[] = [];
  const narrationCalls: NarrationCall[] = [];
  let invalidated = 0;
  // Records the relative order of performer.invalidateNarration vs performer.loadPerformance so a
  // test can prove the bridge populates (→ invalidate) BEFORE it lands the authored Performance
  // (→ load). If that order flips, loadPerformance's authoredPerf is immediately cleared and the
  // export falls back to the script-derived rebuild.
  const order: string[] = [];
  const performer = {
    invalidateNarration() {
      invalidated++;
      order.push('invalidate');
    },
    loadPerformance() {
      order.push('load');
    },
  };
  const projects = {
    // Mirror the REAL importScore: thread `audio` into compileScore's { audio } extra so the
    // assertion proves the bed/SFX actually survive onto the compiled Performance, and call
    // performer.loadPerformance (as projectStore.importScore does) so the order is observable.
    async importScore(score: unknown, stage: Stage, timings: AudioTimings, audio?: AudioCue[]): Promise<Performance> {
      importCalls.push({ score, stage, timings, audio });
      const perf = compileScore(stage, validateScore(score), timings, undefined, audio && audio.length ? { audio } : undefined);
      performer.loadPerformance();
      return perf;
    },
  };
  const timeline = {
    // The bridge import now REPLACES the cue set (importCues) instead of merging via
    // setNarrationCues (whose keep-audio semantics duplicated beds on repeated imports).
    importCues(cues: NarrationCall['cues'], totalSec: number) {
      narrationCalls.push({ cues, totalSec });
    },
    // Decodes imported audio-cue files for the live preview; a stub no-op here.
    async loadAudioAssets() {},
  };
  const c = { projects, timeline, performer } as unknown as BridgeControllers;
  return { c, importCalls, narrationCalls, getInvalidated: () => invalidated, getOrder: () => order };
}

// ── [0] music bed + SFX survive onto Performance.audio ──────────────────────────
describe('g4[0]: applyNewscast re-threads a legacy NewsReportDoc music bed + SFX', () => {
  it('lands audio cues that survive into the compiled Performance (not stripped)', async () => {
    const { app } = makeApp();
    const { c, importCalls } = makeControllers();
    const dispatch = createDispatcher(app, c);

    const res = (await dispatch('applyNewscast', { doc: NEWSCAST })) as { applied: boolean; lowered: boolean };
    expect(res.applied).toBe(true);
    expect(res.lowered).toBe(true); // a NewsReportDoc lowers to a Score

    // The bridge passed the recovered audio into importScore's audio channel…
    const call = importCalls.at(-1)!;
    expect(call.audio && call.audio.length).toBeGreaterThan(0);
    expect(call.audio!.some((a) => a.label === 'music bed' && a.src === '/samples/bed.mp3')).toBe(true);
    expect(call.audio!.some((a) => a.src === '/sfx/whoosh.mp3')).toBe(true);

    // …and they survive onto the compiled Performance (the regression: previously []).
    const perf = compileScore(call.stage, validateScore(call.score), call.timings, undefined, { audio: call.audio });
    expect(perf.audio.some((a) => a.label === 'music bed')).toBe(true);
    expect(perf.audio.some((a) => a.src === '/sfx/whoosh.mp3')).toBe(true);
  });

  it('a pure Score (no NewsReportDoc audio) threads no audio', async () => {
    const { app } = makeApp();
    const { c, importCalls } = makeControllers();
    const dispatch = createDispatcher(app, c);
    const SCORE = { stage: 'newsroom', beats: [{ text: 'Hello world', cues: [] }] };
    const res = (await dispatch('applyNewscast', { doc: SCORE })) as { lowered: boolean };
    expect(res.lowered).toBe(false);
    expect(importCalls.at(-1)!.audio).toBeUndefined();
  });
});

// ── [1] applyNewscast repopulates the studio project ────────────────────────────
describe('g4[1]: applyNewscast repopulates the studio project surface', () => {
  it('sets script text, narration cues, voice, and project name', async () => {
    const { app, dom } = makeApp(['voice-xyz', 'other']);
    const { c, narrationCalls, getInvalidated } = makeControllers();
    const dispatch = createDispatcher(app, c);

    await dispatch('applyNewscast', { doc: NEWSCAST });

    // Script editor = joined beat text; narration invalidated so it rebuilds with TTS timing.
    expect(dom.scriptEl.value).toContain('Good evening and welcome to the broadcast.');
    expect(dom.scriptEl.value).toContain('Markets rose today across the board.');
    expect(getInvalidated()).toBe(1);

    // Voice adopted (exists in the selector) + project name set from the newscast title.
    expect(dom.voiceSel.value).toBe('voice-xyz');
    expect(dom.projectNameEl.value).toBe('Evening_Edition');

    // Timeline got narration cues (one per beat) + the recovered audio cues.
    const call = narrationCalls.at(-1)!;
    const narration = call.cues.filter((x) => x.track === 'narration');
    const audioCues = call.cues.filter((x) => x.track === 'audio');
    expect(narration.length).toBe(2);
    expect(narration.map((x) => x.text)).toContain('Good evening and welcome to the broadcast.');
    expect(audioCues.some((x) => x.label === 'music bed')).toBe(true);
    expect(audioCues.some((x) => x.src === '/sfx/whoosh.mp3')).toBe(true);
    expect(call.totalSec).toBeGreaterThan(0);
  });

  it('does not adopt a voice absent from the selector', async () => {
    const { app, dom } = makeApp(['someone-else']); // 'voice-xyz' not present
    const { c } = makeControllers();
    const dispatch = createDispatcher(app, c);
    await dispatch('applyNewscast', { doc: NEWSCAST });
    expect(dom.voiceSel.value).toBe(''); // left unchanged
  });
});

// ── [2] validateNewscast reports the error from the matched shape ────────────────
describe('g4[2]: validateNewscast reports the NewsReportDoc error, not the Score error', () => {
  // A near-valid NewsReportDoc: correct shape but ONE bad field (an invalid beat emotion).
  const NEAR = {
    ...NEWSCAST,
    rundown: [
      { id: 's1', slug: 'intro', beats: [{ id: 'b1', text: 'Good evening.', emotion: 'not_a_real_emotion' }] },
    ],
  };

  it('surfaces the news-shape error (mentions emotion), not the generic "not a Score" error', async () => {
    const { app } = makeApp();
    const { c } = makeControllers();
    const dispatch = createDispatcher(app, c);

    const res = (await dispatch('validateNewscast', { doc: NEAR })) as { valid: boolean; error: string };
    expect(res.valid).toBe(false);

    // The reported error is the one from validateNewsReportDoc (the matched shape)…
    let newsMsg = '';
    try {
      validateNewsReportDoc(NEAR);
    } catch (e) {
      newsMsg = e instanceof Error ? e.message : String(e);
    }
    let scoreMsg = '';
    try {
      validateScore(NEAR);
    } catch (e) {
      scoreMsg = e instanceof Error ? e.message : String(e);
    }
    expect(res.error).toBe(newsMsg);
    expect(res.error).not.toBe(scoreMsg);
    expect(res.error.toLowerCase()).toContain('emotion'); // the real failing field
  });

  it('still validates a clean newscast as kind=newsreport', async () => {
    const { app } = makeApp();
    const { c } = makeControllers();
    const dispatch = createDispatcher(app, c);
    const res = (await dispatch('validateNewscast', { doc: NEWSCAST })) as { valid: boolean; kind: string; title: string };
    expect(res.valid).toBe(true);
    expect(res.kind).toBe('newsreport');
    expect(res.title).toBe('Evening Edition');
  });

  it('validates a Score as kind=score', async () => {
    const { app } = makeApp();
    const { c } = makeControllers();
    const dispatch = createDispatcher(app, c);
    const SCORE = { stage: 'newsroom', beats: [{ text: 'Hello', cues: [] }] };
    const res = (await dispatch('validateNewscast', { doc: SCORE })) as { valid: boolean; kind: string };
    expect(res.valid).toBe(true);
    expect(res.kind).toBe('score');
  });
});

// ── authored-Performance survival: populate (invalidate) BEFORE import (load) ────
describe('applyNewscast lands the authored Performance after invalidating the prior one', () => {
  it('invalidateNarration runs before loadPerformance, so the authored take survives', async () => {
    const { app } = makeApp();
    const { c, getOrder } = makeControllers();
    const dispatch = createDispatcher(app, c);

    await dispatch('applyNewscast', { doc: NEWSCAST });

    const order = getOrder();
    expect(order).toContain('invalidate');
    expect(order).toContain('load');
    // The regression guard: if import (load) preceded populate (invalidate), the just-landed
    // authoredPerf would be cleared and export would rebuild from the script.
    expect(order.indexOf('invalidate')).toBeLessThan(order.indexOf('load'));
    expect(order.lastIndexOf('invalidate')).toBeLessThan(order.indexOf('load'));
  });
});
