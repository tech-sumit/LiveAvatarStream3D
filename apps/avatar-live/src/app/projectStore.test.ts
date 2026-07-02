import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ProjectStore, type ProjectStoreDeps } from './projectStore.js';
import type { StudioContext } from './context.js';
import type { Cue, Timeline } from '../timeline/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// ProjectStore characterization — the persistence gather/distribute seam.
//
// Same recipe as bridge/dispatch.test.ts: no DOM/THREE/AudioContext — a stub
// `dom` + faithful echo controllers (apply() stores exactly the slice the real
// controller persists, serialize() returns it), so these tests exercise the
// STORE's threading (which dom fields it owns, which doc slice goes to which
// controller, defaults, the busy guard, slide-url resolution, name sanitizing)
// rather than the controllers themselves. Private members are reached via
// TypeScript's sanctioned bracket-notation escape hatch.
//
// The R2/localStorage/network paths (init/save/load) are NOT tested here — they
// need fetch/localStorage and are exercised by the studio smoke test.
// ─────────────────────────────────────────────────────────────────────────────

const LIGHTS = { key: 1.2, fill: 0.5, rim: 0.8, ambient: 0.3, exposure: 1.1, warmth: 0.4, preset: 'evening' };

function makeHarness() {
  const inputStub = () => {
    const events: string[] = [];
    return { value: '', events, dispatchEvent: (e: Event) => (events.push(e.type), true) };
  };
  const dom = {
    scriptEl: inputStub(),
    rateEl: { value: '1' },
    emotionSel: { value: '' },
    shotSel: { value: '' },
    projectNameEl: { value: '' },
    downloadEl: { href: '', download: '', textContent: '', hidden: true, click: () => undefined },
  };
  const logs: string[] = [];
  const preloaded: string[][] = [];
  const emotions: string[] = [];
  const positions: [number, number, number][] = [];
  let busy = false;
  const app = {
    dom,
    log: (m: string) => void logs.push(m),
    isBusy: () => busy,
    avatar: {
      setEmotion: (e: string) => void emotions.push(e),
      // Placement persistence reads group.position/quaternion and applies via setPosition.
      group: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      setPosition: (x: number, y: number, z: number) => void positions.push([x, y, z]),
    },
    studio: { preloadSlideImages: async (urls: string[]) => void preloaded.push(urls) },
  } as unknown as StudioContext;

  // Echo fakes — slice shapes mirror the REAL controllers' serialize() returns
  // (voicePicker/avatarLibrary/lighting/look/backScreen/timelineEditor).
  const voices = {
    state: { voiceId: '', rate: 1, pitch: 1 },
    apply(doc: { voiceId?: string; rate?: number; pitch?: number }) {
      this.state = { voiceId: doc.voiceId ?? '', rate: doc.rate ?? 1, pitch: doc.pitch ?? 1 };
      dom.rateEl.value = String(doc.rate ?? 1); // the real voicePicker.apply writes rateEl
    },
    serialize() {
      return { ...this.state };
    },
  };
  const library = {
    avatarUrl: '',
    async apply(doc: { avatarUrl?: string }) {
      this.avatarUrl = doc.avatarUrl ?? '';
    },
    serialize() {
      return { avatarUrl: this.avatarUrl };
    },
  };
  const lighting = {
    state: { studioOn: true, idleMotion: true, headline: '', lights: LIGHTS },
    apply(doc: { studioOn?: boolean; idleMotion?: boolean; headline?: string; lights?: typeof LIGHTS }) {
      this.state = {
        studioOn: doc.studioOn ?? true,
        idleMotion: doc.idleMotion ?? true,
        headline: doc.headline ?? '',
        lights: doc.lights ?? LIGHTS,
      };
    },
    serialize() {
      return { ...this.state };
    },
  };
  const look = {
    look: undefined as unknown,
    apply(doc: { look?: unknown }) {
      this.look = doc.look;
    },
    serialize() {
      return { look: this.look };
    },
  };
  const backScreen = {
    backScreen: null as unknown,
    urlFns: [] as ((k: string) => string)[],
    apply(doc: { backScreen?: unknown }, urlFor: (k: string) => string) {
      this.backScreen = doc.backScreen ?? null;
      this.urlFns.push(urlFor);
    },
    serialize() {
      return { backScreen: this.backScreen };
    },
  };
  const timeline = {
    timeline: { duration: 20, cues: [] as Cue[] } as Timeline,
    audioLoads: 0,
    blobs: new Map<string, Blob>(),
    applyTimelineDoc(t: Timeline) {
      this.timeline = t;
    },
    async loadAudioAssets(_fetch: (src: string) => Promise<Blob>) {
      this.audioLoads++;
    },
    serialize() {
      return { timeline: { duration: this.timeline.duration, cues: this.timeline.cues } };
    },
  };
  const performer = {
    invalidations: 0,
    rates: [] as number[],
    invalidateNarration() {
      this.invalidations++;
    },
    setRate(r: number) {
      this.rates.push(r);
    },
  };

  const deps = { library, voices, lighting, look, backScreen, timeline, performer } as unknown as ProjectStoreDeps;
  const store = new ProjectStore(app, deps);
  return {
    store,
    dom,
    logs,
    preloaded,
    emotions,
    voices,
    library,
    lighting,
    look,
    backScreen,
    timeline,
    performer,
    setBusy: (v: boolean) => (busy = v),
  };
}

/** A full v2 ProjectDoc covering every persisted field. */
function makeDoc() {
  return {
    version: 2,
    name: 'roundtrip',
    script: '[wave] Good evening.\n[serious] Now the markets.',
    voiceId: 'voice-abc',
    rate: 1.2,
    pitch: 0.9,
    emotion: 'warm',
    avatarUrl: 'avatar-x',
    shot: 'close',
    studioOn: true,
    idleMotion: false,
    headline: 'TOP STORY',
    lights: LIGHTS,
    look: { preset: 'noir' },
    backScreen: { kind: 'url' as const, src: 'https://example.com/wall.mp4' },
    timeline: {
      duration: 12,
      cues: [
        { id: 'n1', track: 'narration', type: 'narration', start: 0, duration: 4, text: 'Good evening.' },
        { id: 'c1', track: 'camera', type: 'cam.anchor', start: 0, duration: 1.5 },
      ] as Cue[],
    },
  };
}

describe('assetUrl — asset src → fetchable URL resolution', () => {
  const { store } = makeHarness();
  const assetUrl = (s: string) => store['assetUrl'](s);

  it('passes absolute http(s) URLs and rooted paths through untouched', () => {
    expect(assetUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
    expect(assetUrl('http://cdn.example.com/x.png')).toBe('http://cdn.example.com/x.png');
    expect(assetUrl('/samples/wall.mp4')).toBe('/samples/wall.mp4');
  });

  it('treats anything else as an R2 key routed via the /r2/o proxy (segments encoded)', () => {
    expect(assetUrl('assets/markets.png')).toBe('/r2/o/assets/markets.png');
    expect(assetUrl('assets/a b.png')).toBe('/r2/o/assets/a%20b.png');
  });

  it('passes blob:/data: URLs through untouched (the shared resolveAssetUrl rule)', () => {
    // assetUrl now delegates to storage/r2.ts resolveAssetUrl — the ONE resolution rule —
    // so a session blob: slide image no longer mangles into a dead /r2/o/… key.
    expect(assetUrl('blob:https://app/xyz')).toBe('blob:https://app/xyz');
    expect(assetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });
});

describe('applyProject — distributes the doc to the dom + every controller', () => {
  it('lands script/emotion/shot on the dom and each slice on its controller', async () => {
    const h = makeHarness();
    const doc = makeDoc();
    await h.store['applyProject'](doc as never);

    expect(h.dom.scriptEl.value).toBe(doc.script);
    expect(h.dom.scriptEl.events).toContain('input'); // highlighter/validity refresh
    expect(h.dom.emotionSel.value).toBe('warm');
    expect(h.emotions).toEqual(['warm']); // avatar face follows the doc emotion
    expect(h.dom.shotSel.value).toBe('close');

    expect(h.voices.state).toEqual({ voiceId: 'voice-abc', rate: 1.2, pitch: 0.9 });
    expect(h.performer.rates).toEqual([1.2]); // rate threads voices.apply → rateEl → performer
    expect(h.performer.invalidations).toBe(1); // stale narration audio dropped
    expect(h.library.avatarUrl).toBe('avatar-x');
    expect(h.lighting.state).toEqual({ studioOn: true, idleMotion: false, headline: 'TOP STORY', lights: LIGHTS });
    expect(h.look.look).toEqual({ preset: 'noir' });
    expect(h.backScreen.backScreen).toEqual({ kind: 'url', src: 'https://example.com/wall.mp4' });
    expect(h.timeline.timeline).toEqual(doc.timeline);
    expect(h.timeline.audioLoads).toBe(1);
    expect(h.logs.at(-1)).toContain('loaded project "roundtrip"');
  });

  it('hands backScreen.apply the shared r2Url resolver', async () => {
    const h = makeHarness();
    await h.store['applyProject'](makeDoc() as never);
    const urlFor = h.backScreen.urlFns.at(-1)!;
    expect(urlFor('assets/wall.mp4')).toBe('/r2/o/assets/wall.mp4');
  });

  it('defaults: missing emotion → neutral, missing shot → medium, missing script keeps editor text', async () => {
    const h = makeHarness();
    h.dom.scriptEl.value = 'keep me';
    const doc = { ...makeDoc(), script: undefined, emotion: undefined, shot: undefined };
    await h.store['applyProject'](doc as never);
    expect(h.dom.scriptEl.value).toBe('keep me');
    expect(h.dom.emotionSel.value).toBe('neutral');
    expect(h.dom.shotSel.value).toBe('medium');
  });

  it('refuses to load while a take/export runs (busy guard) — nothing lands', async () => {
    const h = makeHarness();
    h.setBusy(true);
    await expect(h.store['applyProject'](makeDoc() as never)).rejects.toThrow(/busy/i);
    expect(h.library.avatarUrl).toBe('');
    expect(h.performer.invalidations).toBe(0);
    expect(h.timeline.timeline.cues).toEqual([]);
  });

  it('rewrites R2-key slide images to proxy urls and preloads them (absolute urls untouched)', async () => {
    const h = makeHarness();
    const doc = {
      ...makeDoc(),
      timeline: {
        duration: 10,
        cues: [
          { id: 'g1', track: 'graphics', type: 'gfx.slide', start: 0, duration: 5, slide: { headline: 'A', image: 'assets/markets.png' } },
          { id: 'g2', track: 'graphics', type: 'gfx.slide', start: 5, duration: 3, slide: { headline: 'B', image: 'https://cdn.example.com/x.png' } },
          { id: 'g3', track: 'graphics', type: 'gfx.slide', start: 8, duration: 2, slide: { headline: 'C' } }, // imageless
        ] as Cue[],
      },
    };
    await h.store['applyProject'](doc as never);
    const cues = h.timeline.timeline.cues;
    // The cue itself is REWRITTEN to the resolved url so the url-keyed slide-image
    // cache hits identically live and in export.
    expect(cues[0]!.slide!.image).toBe('/r2/o/assets/markets.png');
    expect(cues[1]!.slide!.image).toBe('https://cdn.example.com/x.png');
    expect(cues[2]!.slide!.image).toBeUndefined();
    expect(h.preloaded).toEqual([['/r2/o/assets/markets.png', 'https://cdn.example.com/x.png']]);
  });

  it('skips slide preloading entirely when no graphics cue carries an image', async () => {
    const h = makeHarness();
    await h.store['applyProject'](makeDoc() as never);
    expect(h.preloaded).toEqual([]);
  });
});

describe('serializeProject / round-trip — gather mirrors distribute', () => {
  it('assembles version 2 + name + dom fields + every controller slice', () => {
    const h = makeHarness();
    h.dom.scriptEl.value = 'A line.';
    h.dom.emotionSel.value = 'happy';
    h.dom.shotSel.value = 'wide';
    h.voices.state = { voiceId: 'v9', rate: 0.8, pitch: 1.1 };
    h.library.avatarUrl = 'ava-2';
    h.lighting.state = { studioOn: false, idleMotion: true, headline: 'H', lights: LIGHTS };
    h.look.look = { preset: 'broadcast' };
    h.backScreen.backScreen = null;
    h.timeline.timeline = { duration: 30, cues: [] };

    expect(h.store['serializeProject']('mydoc')).toEqual({
      version: 2,
      name: 'mydoc',
      script: 'A line.',
      voiceId: 'v9',
      rate: 0.8,
      pitch: 1.1,
      emotion: 'happy',
      avatarUrl: 'ava-2',
      shot: 'wide',
      studioOn: false,
      idleMotion: true,
      headline: 'H',
      lights: LIGHTS,
      look: { preset: 'broadcast' },
      backScreen: null,
      timeline: { duration: 30, cues: [] },
    });
  });

  it('applyProject → serializeProject preserves every persisted field', async () => {
    // The save/load round-trip contract: loading a doc then saving it must not
    // lose or alter script/voice/rate/pitch/emotion/shot/lights/look/backScreen/
    // timeline. (Docs with R2-key slide images are excluded — applyProject
    // intentionally rewrites those to proxy urls; pinned above.)
    const h = makeHarness();
    const doc = makeDoc();
    await h.store['applyProject'](doc as never);
    expect(h.store['serializeProject'](doc.name)).toEqual(doc);
  });
});

describe('importNewsReport — validate → compile → apply → sanitized name', () => {
  // A minimal valid NewsReportDoc (same shape dispatch.test.ts uses).
  const NEWSCAST = {
    version: 2,
    meta: {
      title: 'Evening Edition',
      anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice-xyz' }],
    },
    defaults: { emotion: 'neutral' },
    rundown: [
      { id: 's1', slug: 'intro', beats: [{ id: 'b1', text: 'Good evening and welcome to the broadcast.', gesture: 'wave', emotion: 'warm' }] },
      { id: 's2', slug: 'markets', beats: [{ id: 'b2', text: 'Markets rose today across the board.' }] },
    ],
  };

  it('applies the compiled project and sets the sanitized title as the project name', async () => {
    const h = makeHarness();
    const title = await h.store.importNewsReport(NEWSCAST);
    expect(title).toBe('Evening Edition'); // raw title returned…
    expect(h.dom.projectNameEl.value).toBe('Evening_Edition'); // …sanitized on the dom
    expect(h.dom.scriptEl.value).toContain('Good evening and welcome to the broadcast.');
    expect(h.dom.scriptEl.value).toContain('Markets rose today across the board.');
    expect(h.timeline.timeline.cues.some((c) => c.track === 'narration')).toBe(true);
    expect(h.library.avatarUrl).toBe('avaturn-model');
    expect(h.logs.some((l) => l.includes('imported newscast: Evening Edition'))).toBe(true);
  });

  it('sanitizes punctuation runs in the title to single underscores', async () => {
    // Pinned: sanitize collapses each run of [^\w.-] to one '_' — including a
    // trailing one ('!' → '_'), which is current behavior.
    const h = makeHarness();
    const doc = { ...NEWSCAST, meta: { ...NEWSCAST.meta, title: 'Q2: Markets & More!' } };
    await h.store.importNewsReport(doc);
    expect(h.dom.projectNameEl.value).toBe('Q2_Markets_More_');
  });

  it('rejects an invalid doc before touching any controller', async () => {
    const h = makeHarness();
    const bad = { ...NEWSCAST, rundown: 'nope' };
    await expect(h.store.importNewsReport(bad)).rejects.toThrow();
    expect(h.timeline.timeline.cues).toEqual([]);
    expect(h.dom.projectNameEl.value).toBe('');
  });
});

describe('exportProjectJson — filename comes from the sanitized project name', () => {
  it('an empty name falls back to "untitled"', () => {
    const h = makeHarness();
    h.dom.projectNameEl.value = '   ';
    h.store['exportProjectJson']();
    expect(h.dom.downloadEl.download).toBe('untitled.project.json');
  });

  it('path separators and spaces in the name become underscores', () => {
    // Keeps saved-project keys flat — 'ep 1/finale' cannot nest under projects/.
    const h = makeHarness();
    h.dom.projectNameEl.value = 'ep 1/finale';
    h.store['exportProjectJson']();
    expect(h.dom.downloadEl.download).toBe('ep_1_finale.project.json');
  });
});
