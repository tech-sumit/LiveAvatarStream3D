import { z } from 'zod';
import { Emotion, Gesture, CameraCue } from './dsl.js';
import { PostProcessingSpec } from './scene.js';

/** A presenter. `avatarUrl` is a folder id (e.g. 'avaturn-model') or an http(s) URL. */
export const Anchor = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  avatarUrl: z.string().min(1),
  voiceId: z.string().min(1),
  rate: z.number().min(0.5).max(2).default(1),
  pitch: z.number().min(0.5).max(2).default(1),
});
export type Anchor = z.infer<typeof Anchor>;

export const Meta = z.object({
  title: z.string().min(1),
  anchors: z.array(Anchor).min(1),
  language: z.string().min(2).default('en'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
});
export type Meta = z.infer<typeof Meta>;

/** Set / background. MVP wires `mode` (virtual↔real → studioOn) + `backScreen`. */
export const SectionSet = z.object({
  mode: z.enum(['virtual', 'real', 'chroma', 'LED', 'AR']).default('virtual'),
  backScreen: z.object({ kind: z.enum(['url', 'r2']), src: z.string().min(1) }).optional(),
});
export type SectionSet = z.infer<typeof SectionSet>;

export const AudioCue = z.object({
  id: z.string().min(1),
  kind: z.enum(['bed', 'sfx', 'natpop']).default('bed'),
  src: z.string().min(1),
  start: z.number().min(0).default(0),
  duration: z.number().min(0).default(0),
  volume: z.number().min(0).max(1).default(0.8),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
  label: z.string().optional(),
});
export type AudioCue = z.infer<typeof AudioCue>;

export const Beat = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(2000),
  emotion: Emotion.optional(),
  gesture: Gesture.optional(),
  pause_ms_after: z.number().int().min(0).max(5000).default(0),
  camera: CameraCue.optional(),
  note: z.string().optional(), // stripped at compile; never rendered
});
export type Beat = z.infer<typeof Beat>;

/** Story forms. The MVP compiler treats every form as a straight read (READER/VO); others are accepted for forward-compat. */
export const StoryForm = z.enum(['READER', 'VO', 'VOSOT', 'PKG', 'LIVE', 'STANDUP', 'KICKER']);
export type StoryForm = z.infer<typeof StoryForm>;

export const Section = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  storyForm: StoryForm.default('READER'),
  anchorId: z.string().optional(), // MVP uses meta.anchors[0]; per-section anchor is V2
  set: SectionSet.optional(),
  cameraDefault: CameraCue.optional(),
  headline: z.string().optional(),
  beats: z.array(Beat).min(1),
  audio: z.array(AudioCue).default([]),
});
export type Section = z.infer<typeof Section>;

export const DocDefaults = z.object({
  emotion: Emotion.optional(),
  gesture: Gesture.optional(),
  pause_ms_after: z.number().int().min(0).default(0),
  camera: CameraCue.optional(),
  set: SectionSet.optional(),
  idleMotion: z.boolean().default(false),
  headline: z.string().optional(),
  music: z
    .object({
      src: z.string().min(1),
      volume: z.number().min(0).max(1).default(0.25),
      fadeIn: z.number().min(0).default(1),
      fadeOut: z.number().min(0).default(1.5),
    })
    .optional(),
});
export type DocDefaults = z.infer<typeof DocDefaults>;

export const NewsReportDoc = z.object({
  version: z.literal(2),
  meta: Meta,
  look: PostProcessingSpec.optional(),
  defaults: DocDefaults.optional(),
  rundown: z.array(Section).min(1), // MVP: single-act sugar. `acts` (setup/action/packup) deferred to V2.
});
export type NewsReportDoc = z.infer<typeof NewsReportDoc>;

/** Parse + validate untrusted input into a NewsReportDoc (throws ZodError on invalid). */
export function validateNewsReportDoc(data: unknown): NewsReportDoc {
  return NewsReportDoc.parse(data);
}
