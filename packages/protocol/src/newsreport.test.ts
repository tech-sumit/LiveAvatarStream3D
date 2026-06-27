import { describe, it, expect } from 'vitest';
import { validateNewsReportDoc, NewsReportDoc } from './newsreport.js';
import { compileNewsReport } from './newsreportCompile.js';

const DOC = {
  version: 2 as const,
  meta: { title: 'Evening Edition', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'avaturn-model', voiceId: 'voice_ava' }] },
  look: { preset: 'noir' as const, saturation: -1, contrast: 0.3 },
  defaults: { emotion: 'neutral' as const, music: { src: '/samples/bed.mp3' } },
  rundown: [
    {
      id: 's1', slug: 'top', storyForm: 'READER' as const, headline: 'Top story',
      beats: [
        { id: 'b1', text: 'Good evening', emotion: 'warm' as const, gesture: 'wave' as const, camera: { shot: 'close_up' as const } },
        { id: 'b2', text: 'Here is the news' },
      ],
    },
    {
      id: 's2', slug: 'two', storyForm: 'VO' as const,
      beats: [{ id: 'b3', text: 'Markets rose today', emotion: 'confident' as const, camera: { shot: 'wide' as const } }],
    },
  ],
};

describe('NewsReportDoc schema', () => {
  it('parses a valid doc + applies defaults', () => {
    const d = validateNewsReportDoc(DOC);
    expect(d.meta.fps).toBe(30); // default
    expect(d.meta.anchors[0]?.rate).toBe(1); // default
    expect(d.rundown).toHaveLength(2);
  });
  it('rejects an invalid emotion enum', () => {
    expect(() => validateNewsReportDoc({ ...DOC, rundown: [{ ...DOC.rundown[0], beats: [{ id: 'x', text: 'hi', emotion: 'bogus' }] }] })).toThrow();
  });
  it('rejects version != 2', () => {
    expect(() => validateNewsReportDoc({ ...DOC, version: 1 })).toThrow();
  });
});

describe('compileNewsReport', () => {
  const { project, cues } = compileNewsReport(NewsReportDoc.parse(DOC));
  it('sets doc-level scalars from anchors[0] + meta', () => {
    expect(project.name).toBe('Evening Edition');
    expect(project.voiceId).toBe('voice_ava');
    expect(project.avatarUrl).toBe('avaturn-model');
    expect(project.emotion).toBe('warm'); // first beat resolved
    expect(project.shot).toBe('close'); // first beat close_up
    expect(project.headline).toBe('Top story');
  });
  it('renders beats to a sentence-split script with inline [emotion][gesture] tags', () => {
    expect(project.script).toContain('[warm][wave] Good evening.');
    expect(project.script).toContain('[warm][none] Here is the news.'); // emotion sticky in section, gesture per-beat
    expect(project.script).toContain('[confident][none] Markets rose today.');
  });
  it('emits a camera cue on change + a motion cue on gesture', () => {
    const cam = cues.filter((c) => c.track === 'camera');
    expect(cam[0]?.type).toBe('cam.close'); // first beat
    expect(cam.some((c) => c.type === 'cam.wide')).toBe(true); // section 2 wide
    expect(cues.some((c) => c.track === 'motion' && c.type === 'motion.wave')).toBe(true);
  });
  it('bridges the flat look spec into ProjectDoc.look.params + lights', () => {
    expect(project.look?.preset).toBe('noir');
    expect(project.look?.params?.saturation).toBe(-1);
    expect(project.lights.preset).toBe('dramatic'); // noir → dramatic
  });
  it('emits a music bed audio cue spanning the timeline', () => {
    const bed = cues.find((c) => c.track === 'audio' && c.label === 'music bed');
    expect(bed?.start).toBe(0);
    expect(bed?.duration).toBe(project.timeline.duration);
  });
  it('narration cue count == beat count', () => {
    expect(cues.filter((c) => c.track === 'narration')).toHaveLength(3);
  });
  it('emits one graphics (wall-slide) cue per section, at each section start', () => {
    const gfx = cues.filter((c) => c.track === 'graphics');
    expect(gfx).toHaveLength(2); // two sections
    expect(gfx[0]?.start).toBe(0); // section 1 starts at t=0
    expect(gfx[1]?.start).toBeGreaterThan(0); // section 2 starts after section 1's beats
    expect(gfx.every((c) => c.type === 'graphic.slide')).toBe(true);
  });
  it('the first slide payload is derived from the section (headline, LIVE kicker, empty bullets)', () => {
    const gfx = cues.filter((c) => c.track === 'graphics');
    expect(gfx[0]?.slide?.headline).toBe('Top story'); // section.headline
    expect(gfx[0]?.slide?.kicker).toBe('LIVE');
    expect(gfx[0]?.slide?.bullets).toEqual([]);
    // Section 2 has no headline → falls back to the doc title.
    expect(gfx[1]?.slide?.headline).toBe('Evening Edition');
  });
  it('the ticker is STORY-derived (not the old hardcoded studio string)', () => {
    const gfx = cues.filter((c) => c.track === 'graphics');
    const OLD = 'BREAKING  ·  REALTIME 3D ANCHOR  ·  BROWSER-RENDERED  ·  LIP-SYNCED';
    expect(gfx[0]?.slide?.ticker).not.toBe(OLD);
    expect(gfx[0]?.slide?.ticker).toContain('TOP STORY'); // derived from the headline
  });
});

describe('compileNewsReport — authored slide content (bullets / graphic / ticker)', () => {
  const RICH = {
    version: 2 as const,
    meta: { title: 'Newsdesk', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'm', voiceId: 'v' }] },
    defaults: { ticker: 'DEFAULT TICKER' },
    rundown: [
      {
        id: 's1', slug: 'one', headline: 'Section one',
        bullets: ['Point A', 'Point B'],
        graphic: { kind: 'url' as const, src: 'https://cdn.example/back.jpg' },
        ticker: 'CUSTOM SECTION TICKER',
        beats: [{ id: 'b1', text: 'Hello there' }],
      },
      {
        id: 's2', slug: 'two', headline: 'Section two',
        beats: [{ id: 'b2', text: 'More news here' }], // no ticker → falls back to defaults.ticker
      },
    ],
  };
  const { cues } = compileNewsReport(NewsReportDoc.parse(RICH));
  const gfx = cues.filter((c) => c.track === 'graphics');
  it('carries authored bullets + the backdrop image src onto the slide', () => {
    expect(gfx[0]?.slide?.bullets).toEqual(['Point A', 'Point B']);
    expect(gfx[0]?.slide?.image).toBe('https://cdn.example/back.jpg');
  });
  it('uses the section ticker, then the defaults ticker as fallback', () => {
    expect(gfx[0]?.slide?.ticker).toBe('CUSTOM SECTION TICKER'); // section-level wins
    expect(gfx[1]?.slide?.ticker).toBe('DEFAULT TICKER'); // defaults.ticker fallback
    expect(gfx[1]?.slide?.image).toBeUndefined(); // no graphic authored
  });
});

describe('compileNewsReport — authored camera pose (DATA) → cam.custom', () => {
  const POSE = { pos: [0.97, 1.5, 3.81] as [number, number, number], target: [1.66, 1.5, -0.3] as [number, number, number], fov: 32 };
  const DOC_POSE = {
    version: 2 as const,
    meta: { title: 'Posed', anchors: [{ id: 'a1', name: 'Ava', avatarUrl: 'm', voiceId: 'v' }] },
    defaults: { cameraPose: POSE },
    rundown: [
      { id: 's1', slug: 'one', beats: [{ id: 'b1', text: 'Good evening', camera: { shot: 'close_up' as const } }] },
      { id: 's2', slug: 'two', beats: [{ id: 'b2', text: 'Markets rose', camera: { shot: 'wide' as const } }] },
    ],
  };
  const { cues } = compileNewsReport(NewsReportDoc.parse(DOC_POSE));
  it('emits ONE cam.custom cue with the explicit pose tuple, suppressing the preset cam buckets', () => {
    const cam = cues.filter((c) => c.track === 'camera');
    expect(cam).toHaveLength(1);
    expect(cam[0]?.type).toBe('cam.custom');
    // PoseTuple = [px,py,pz, tx,ty,tz, fov] — the studio's resolvePose/tupleToPose consumes this verbatim.
    expect(cam[0]?.pose).toEqual([0.97, 1.5, 3.81, 1.66, 1.5, -0.3, 32]);
    expect(cam.some((c) => c.type === 'cam.close' || c.type === 'cam.wide')).toBe(false);
  });
});
