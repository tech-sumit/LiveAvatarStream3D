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
    emotionSel: selectStub(['neutral', 'warm']),
  };
  const logs: string[] = [];
  let busy = false;
  const app = {
    dom,
    log: (m: string) => logs.push(m),
    avatar: { setEmotion: () => undefined },
    studio: { preloadSlideImages: async () => undefined },
    isBusy: () => busy,
  } as unknown as Parameters<typeof createDispatcher>[0];
  return { app, dom, logs, setBusy: (v: boolean) => (busy = v) };
}

interface ImportCall {
  score: unknown;
  stage: Stage;
  timings: AudioTimings;
  audio?: AudioCue[];
  slides?: { tSec: number; slide: unknown }[];
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
    async importScore(
      score: unknown,
      stage: Stage,
      timings: AudioTimings,
      audio?: AudioCue[],
      extra?: { slides?: { tSec: number; slide: unknown }[] },
    ): Promise<Performance> {
      importCalls.push({ score, stage, timings, audio, slides: extra?.slides });
      // Mirror the REAL importScore → performer.loadScore compile (audio + slides threaded).
      const perf = compileScore(stage, validateScore(score), timings, undefined, {
        ...(audio && audio.length ? { audio } : {}),
        ...(extra?.slides?.length ? { slides: extra.slides as never } : {}),
      });
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
  // Chrome appliers (the applyNewsChrome parity surface) — each records what it received.
  const chrome: Record<string, unknown[]> = { voices: [], lighting: [], look: [], library: [], backScreen: [] };
  const voices = { apply: (doc: unknown) => chrome.voices!.push(doc) };
  const lighting = { apply: (doc: unknown) => chrome.lighting!.push(doc) };
  const look = { apply: (doc: unknown) => chrome.look!.push(doc) };
  const library = { apply: async (doc: unknown) => void chrome.library!.push(doc) };
  const backScreen = { apply: (doc: unknown) => chrome.backScreen!.push(doc) };
  const c = { projects, timeline, performer, voices, lighting, look, library, backScreen } as unknown as BridgeControllers;
  return { c, importCalls, narrationCalls, chrome, getInvalidated: () => invalidated, getOrder: () => order };
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

// ── round-2 unification: bridge chrome parity + slides + one clock ───────────────
describe('applyNewscast carries FULL chrome (parity with the file-import path)', () => {
  // A chrome-rich doc: look, section slides (headline/bullets/ticker/graphic), backScreen,
  // rate/pitch, and a camera preset — everything the Score path used to drop.
  const RICH = {
    ...NEWSCAST,
    look: { preset: 'noir', contrast: 0.3 },
    meta: {
      title: 'Evening Edition',
      anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice-xyz', rate: 1.1, pitch: 0.9 }],
    },
    rundown: [
      {
        id: 's1',
        slug: 'intro',
        headline: 'Top Story Tonight',
        bullets: ['point one'],
        ticker: 'BREAKING · MARKETS UP',
        set: { mode: 'virtual', backScreen: { kind: 'url', src: 'https://example.com/wall.mp4' } },
        beats: [{ id: 'b1', text: 'Good evening and welcome to the broadcast.', camera: { preset: 'hero-low' } }],
      },
      {
        id: 's2',
        slug: 'markets',
        headline: 'Markets Rally',
        graphic: { kind: 'r2', src: 'assets/markets.png' },
        beats: [{ id: 'b2', text: 'Markets rose today across the board.' }],
        audio: [{ id: 'sfx1', kind: 'sfx', src: '/sfx/whoosh.mp3', start: 0.5, duration: 1 }],
      },
    ],
  };

  it('applies avatar, voice rate/pitch, look, lighting, and backScreen via the shared appliers', async () => {
    const { app } = makeApp();
    const { c, chrome } = makeControllers();
    const dispatch = createDispatcher(app, c);
    await dispatch('applyNewscast', { doc: RICH });

    // The SAME values compileNewsReport lowers for the file path (parity by construction).
    const { compileNewsReport, validateNewsReportDoc: v } = await import('@las/protocol');
    const { project } = compileNewsReport(v(RICH));

    const voicesCall = chrome.voices!.at(-1) as { voiceId: string; rate: number; pitch: number };
    expect(voicesCall.voiceId).toBe('voice-xyz');
    expect(voicesCall.rate).toBeCloseTo(1.1, 6);
    expect(voicesCall.pitch).toBeCloseTo(0.9, 6);

    const libraryCall = chrome.library!.at(-1) as { avatarUrl: string };
    expect(libraryCall.avatarUrl).toBe('avaturn-model');

    const lightingCall = chrome.lighting!.at(-1) as { studioOn?: boolean; headline?: string };
    expect(lightingCall.studioOn).toBe(project.studioOn);
    expect(lightingCall.headline).toBe(project.headline);

    const lookCall = chrome.look!.at(-1) as { look?: { preset?: string } };
    expect(lookCall.look?.preset).toBe('noir');

    const backScreenCall = chrome.backScreen!.at(-1) as { backScreen?: { src: string } | null };
    expect(backScreenCall.backScreen?.src).toBe('https://example.com/wall.mp4');
  });

  it('threads wall slides into Performance.slides AND the timeline graphics cues, on one clock', async () => {
    const { app } = makeApp();
    const { c, importCalls, narrationCalls } = makeControllers();
    const dispatch = createDispatcher(app, c);
    await dispatch('applyNewscast', { doc: RICH });

    const call = importCalls.at(-1)!;
    expect(call.slides?.length).toBe(2); // one per section
    const slide0 = call.slides![0]!.slide as { headline: string; ticker: string; bullets: string[] };
    expect(slide0.headline).toBe('Top Story Tonight');
    expect(slide0.ticker).toBe('BREAKING · MARKETS UP');
    expect(slide0.bullets).toEqual(['point one']);
    // The R2 graphic key resolves to the proxy url shape for the image cache.
    const slide1 = call.slides![1]!.slide as { image?: string };
    expect(slide1.image).toBe('/r2/o/assets/markets.png');

    // Section 2's slide starts at its first beat's startSec on the SAME timings clock.
    expect(call.slides![1]!.tSec).toBeCloseTo(call.timings.beats[1]!.startSec, 1);

    // The compiled Performance carries them (compileScore extra.slides — was hardcoded []).
    const perf = compileScore(call.stage, validateScore(call.score), call.timings, undefined, {
      slides: call.slides as never,
    });
    expect(perf.slides.length).toBe(2);

    // The editor sees them too: graphics cues in the clean-slate import.
    const cues = narrationCalls.at(-1)!.cues;
    expect(cues.filter((x) => x.track === 'graphics').length).toBe(2);
  });

  it('lowers a camera preset into the Score (no spurious medium frame cue)', async () => {
    const { app } = makeApp();
    const { c, importCalls } = makeControllers();
    const dispatch = createDispatcher(app, c);
    await dispatch('applyNewscast', { doc: RICH });

    const score = validateScore(importCalls.at(-1)!.score);
    const camCues = score.beats.flatMap((b) => b.cues.filter((q) => 'camera' in q)) as { camera: unknown }[];
    expect(camCues.some((q) => (q.camera as { preset?: string }).preset === 'hero-low')).toBe(true);
    // No shot-bucket frame cue emitted alongside the preset.
    expect(camCues.some((q) => 'frame' in (q.camera as object))).toBe(false);

    // …and the compiled keyframe carries the preset for the runtime resolver.
    const call = importCalls.at(-1)!;
    const perf = compileScore(call.stage, score, call.timings);
    expect(perf.camera.some((k) => k.preset === 'hero-low')).toBe(true);
  });
});

// ── busy guard: apply_newscast must refuse to run under a take/export ────────────
describe('applyNewscast busy guard (parity with applyProject)', () => {
  it('rejects while the studio is busy — no chrome/timeline mutation lands mid-export', async () => {
    const { app, setBusy } = makeApp();
    const { c, importCalls, narrationCalls, chrome } = makeControllers();
    const dispatch = createDispatcher(app, c);
    setBusy(true);
    await expect(dispatch('applyNewscast', { doc: NEWSCAST })).rejects.toThrow(/busy/i);
    expect(importCalls.length).toBe(0);
    expect(narrationCalls.length).toBe(0);
    expect(chrome.library!.length).toBe(0);
  });
});
