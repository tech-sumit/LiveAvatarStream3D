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
});
