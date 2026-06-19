import { z } from 'zod';
import { SceneDocument } from './scene.js';
import {
  CameraCue,
  CameraEasing,
  Emotion,
  Gesture,
  Posture,
  Script,
  type Emotion as EmotionT,
  type Gesture as GestureT,
  type Posture as PostureT,
} from './dsl.js';

/**
 * The **performance manifest** is the data contract between our control plane
 * and the Three.js render node (glTF avatar + lip-sync face drive). It is the 3D-engine analogue of the GPU pipeline's render
 * call: a fully-resolved, engine-agnostic timeline produced by compiling an
 * LLM-director DSL `Script` together with the synthesized TTS audio.
 *
 * The control plane owns "the brain" (DSL) and "the voice" (TTS); the engine
 * owns body animation, stage, virtual camera, and recording. This manifest is
 * the hand-off: every beat already carries its absolute timing, its resolved
 * Animation Montage id, its ACE Audio2Face emotion drive, its posture blend
 * params, and the camera move to run. The engine never re-interprets the DSL —
 * it plays back exactly what the manifest specifies.
 *
 * See docs/specs/2026-06-18-3d-engine-poc.md.
 */

// --- ACE Audio2Face-3D emotion space ---------------------------------------

/**
 * Emotion labels emitted/consumed by NVIDIA ACE Audio2Face-3D's Audio2Emotion
 * model. We resolve our 10-value DSL `Emotion` down to one of these plus an
 * intensity so the engine can drive the MetaHuman face directly. A2F blends its
 * own audio-derived emotion with this explicit drive (see render script).
 */
export const A2F_EMOTIONS = [
  'neutral',
  'amazement',
  'anger',
  'cheekiness',
  'disgust',
  'fear',
  'grief',
  'joy',
  'outofbreath',
  'pain',
  'sadness',
] as const;
export const A2FEmotion = z.enum(A2F_EMOTIONS);
export type A2FEmotion = z.infer<typeof A2FEmotion>;

/** DSL emotion -> ACE Audio2Face emotion + drive intensity (0..1). */
export const EMOTION_TO_A2F: Record<EmotionT, { a2f: A2FEmotion; intensity: number }> = {
  neutral: { a2f: 'neutral', intensity: 0.0 },
  warm: { a2f: 'joy', intensity: 0.35 },
  happy: { a2f: 'joy', intensity: 0.7 },
  excited: { a2f: 'amazement', intensity: 0.8 },
  serious: { a2f: 'neutral', intensity: 0.15 },
  concerned: { a2f: 'fear', intensity: 0.35 },
  sad: { a2f: 'sadness', intensity: 0.7 },
  confident: { a2f: 'cheekiness', intensity: 0.45 },
  thoughtful: { a2f: 'neutral', intensity: 0.2 },
  surprised: { a2f: 'amazement', intensity: 0.85 },
};

// --- Body animation (Animation Montages) -----------------------------------

/**
 * The POC ships exactly three hand-authored body Animation Montages on the
 * MetaHuman body skeleton. The director's `gesture`/`posture` vocabulary is
 * collapsed onto these three (plus an implicit idle = no montage). Extend the
 * montage set and this map together; the engine only ever sees the resolved id.
 */
export const MONTAGE_IDS = ['M_Explain', 'M_LeanIn', 'M_Nod'] as const;
export const MontageId = z.enum(MONTAGE_IDS);
export type MontageId = z.infer<typeof MontageId>;

/** Resolve a beat's gesture (primary) + posture (fallback) to a montage, or
 * null to mean "stay in idle for this beat". */
export function resolveMontage(gesture: GestureT, posture: PostureT): MontageId | null {
  switch (gesture) {
    case 'explain':
    case 'open_palms':
    case 'point':
    case 'count':
    case 'wave':
    case 'shrug':
      return 'M_Explain';
    case 'nod':
    case 'thumbs_up':
      return 'M_Nod';
    case 'hand_to_chest':
      return 'M_LeanIn';
    case 'none':
      // No explicit gesture: let posture decide whether to lean in.
      return posture === 'leaning_in' ? 'M_LeanIn' : null;
    default: {
      const _exhaustive: never = gesture;
      return _exhaustive;
    }
  }
}

/** Posture -> a normalized upper-body lean blend param (0 = upright back, 1 =
 * leaning toward camera). Drives an additive lean pose layered over montages. */
export const POSTURE_TO_LEAN: Record<PostureT, number> = {
  neutral: 0.0,
  leaning_in: 0.7,
  upright: -0.2,
  relaxed: 0.1,
  turned_slightly: 0.0,
};

/** Posture -> yaw offset in degrees applied to the body (turned_slightly). */
export const POSTURE_TO_YAW_DEG: Record<PostureT, number> = {
  neutral: 0,
  leaning_in: 0,
  upright: 0,
  relaxed: 0,
  turned_slightly: 18,
};

// --- Manifest schema --------------------------------------------------------

export const Resolution = z.object({
  width: z.number().int().positive().default(3840),
  height: z.number().int().positive().default(2160),
});
export type Resolution = z.infer<typeof Resolution>;

/** Reference to the muxed/full TTS audio track on R2 that the Sequencer binds. */
export const AudioRef = z.object({
  /** R2 object key of the full performance audio (wav/mp3). */
  r2Key: z.string(),
  durationS: z.number().nonnegative(),
  sampleRate: z.number().int().positive().default(48000),
});
export type AudioRef = z.infer<typeof AudioRef>;

/** Resolved facial drive for a beat (fed to ACE Audio2Face Audio2Emotion). */
export const FaceDrive = z.object({
  emotion: Emotion,
  a2fEmotion: A2FEmotion,
  /** Strength of the explicit emotion drive blended over A2F's audio-derived one. */
  intensity: z.number().min(0).max(1),
});
export type FaceDrive = z.infer<typeof FaceDrive>;

/** Resolved body drive for a beat. */
export const BodyDrive = z.object({
  gesture: Gesture,
  posture: Posture,
  /** Montage to fire at the beat start, or null to hold idle. */
  montageId: MontageId.nullable(),
  /** Additive lean blend param (see POSTURE_TO_LEAN). */
  lean: z.number(),
  /** Body yaw offset in degrees (see POSTURE_TO_YAW_DEG). */
  yawDeg: z.number(),
});
export type BodyDrive = z.infer<typeof BodyDrive>;

/** One beat of the compiled performance timeline. */
export const ManifestBeat = z.object({
  seq: z.number().int().nonnegative(),
  /** Absolute start time of this beat on the master timeline, seconds. */
  startS: z.number().nonnegative(),
  /** Absolute end time (= startS + spoken duration), seconds. Excludes the
   * trailing pause, which is captured by the next beat's startS gap. */
  endS: z.number().nonnegative(),
  /** Offset of this beat's audio within the master audio track, seconds. */
  audioOffsetS: z.number().nonnegative(),
  /** Spoken duration of this beat, seconds. */
  durationS: z.number().nonnegative(),
  text: z.string(),
  emphasis: z.array(z.string()),
  face: FaceDrive,
  body: BodyDrive,
});
export type ManifestBeat = z.infer<typeof ManifestBeat>;

/** A resolved virtual-camera shot on the master timeline. */
export const CameraShotKeyframe = z.object({
  /** Beat seq this shot was attached to (for traceability). */
  seq: z.number().int().nonnegative(),
  startS: z.number().nonnegative(),
  durationS: z.number().nonnegative(),
  shot: CameraCue.shape.shot,
  move: CameraCue.shape.move,
  target: CameraCue.shape.target,
  easing: CameraEasing,
  intensity: z.number().min(0).max(1),
});
export type CameraShotKeyframe = z.infer<typeof CameraShotKeyframe>;

/** Stage / lighting / subject the render node loads before sequencing. */
export const StageSpec = z.object({
  /** Stage preset id (e.g. studio). */
  level: z.string().default('studio'),
  /** Named lighting rig preset. */
  lighting: z.string().default('three_point_warm'),
  /** Avatar asset id (glTF basename under engine-three/assets/avatars/). */
  avatarId: z.string(),
});
export type StageSpec = z.infer<typeof StageSpec>;

/** The full hand-off the engine renders. */
export const PerformanceManifest = z.object({
  version: z.literal(1).default(1),
  jobId: z.string(),
  language: z.string().default('en'),
  fps: z.number().int().min(24).max(60).default(24),
  resolution: Resolution.default({}),
  /** Total timeline length, seconds. */
  durationS: z.number().nonnegative(),
  stage: StageSpec,
  audio: AudioRef,
  beats: z.array(ManifestBeat).min(1),
  camera: z.array(CameraShotKeyframe).min(1),
  /** When present, engine-three uses this scene graph instead of procedural camera shots. */
  scene: SceneDocument.optional(),
});
export type PerformanceManifest = z.infer<typeof PerformanceManifest>;

// --- Compiler ---------------------------------------------------------------

/** Per-beat synthesized-audio timing, produced by the TTS step. The control
 * plane pairs each script segment (by index) with the duration of its rendered
 * audio so the manifest can lay out absolute timing. */
export interface BeatAudioTiming {
  /** Spoken duration of the segment's audio, seconds. */
  durationS: number;
}

export interface CompileManifestInput {
  jobId: string;
  script: Script;
  stage: StageSpec;
  audio: AudioRef;
  /** One entry per script segment, in segment order. */
  timings: BeatAudioTiming[];
  fps?: number;
  resolution?: Resolution;
  /** Editor scene snapshot for WYSIWYG render (passed through to the manifest). */
  scene?: SceneDocument;
}

const DEFAULT_CAMERA: CameraCue = {
  shot: 'medium',
  move: 'static',
  target: 'face',
  easing: 'ease_in_out',
  intensity: 0.5,
};

/**
 * Compile an LLM-director `Script` + TTS timing into a `PerformanceManifest`.
 * Pure and deterministic: same inputs -> same manifest. Absolute beat timing is
 * the running sum of each segment's spoken duration plus its `pause_ms_after`.
 * A camera cue carries forward until a beat overrides it, so the engine always
 * has a defined shot. Throws if `timings` length doesn't match the script.
 */
export function compileManifest(input: CompileManifestInput): PerformanceManifest {
  const { jobId, script, stage, audio, timings } = input;
  if (timings.length !== script.segments.length) {
    throw new Error(
      `timings length ${timings.length} != segments length ${script.segments.length}`,
    );
  }

  const beats: ManifestBeat[] = [];
  const camera: CameraShotKeyframe[] = [];
  let cursorS = 0;
  let activeCamera: CameraCue = DEFAULT_CAMERA;

  script.segments.forEach((seg, i) => {
    const durationS = Math.max(0, timings[i]?.durationS ?? 0);
    const startS = cursorS;
    const endS = startS + durationS;
    const { a2f, intensity } = EMOTION_TO_A2F[seg.emotion];

    beats.push({
      seq: seg.seq,
      startS,
      endS,
      audioOffsetS: startS,
      durationS,
      text: seg.text,
      emphasis: seg.emphasis,
      face: { emotion: seg.emotion, a2fEmotion: a2f, intensity },
      body: {
        gesture: seg.gesture,
        posture: seg.posture,
        montageId: resolveMontage(seg.gesture, seg.posture),
        lean: POSTURE_TO_LEAN[seg.posture],
        yawDeg: POSTURE_TO_YAW_DEG[seg.posture],
      },
    });

    if (seg.camera) activeCamera = { ...DEFAULT_CAMERA, ...seg.camera };
    // A shot spans its beat plus the trailing pause so the move resolves on a
    // held frame rather than snapping at the next beat's audio onset.
    const pauseS = seg.pause_ms_after / 1000;
    camera.push({
      seq: seg.seq,
      startS,
      durationS: durationS + pauseS,
      shot: activeCamera.shot,
      move: activeCamera.move,
      target: activeCamera.target,
      easing: activeCamera.easing,
      intensity: activeCamera.intensity,
    });

    cursorS = endS + pauseS;
  });

  return PerformanceManifest.parse({
    jobId,
    language: script.language,
    fps: input.fps ?? 24,
    resolution: input.resolution ?? {},
    durationS: cursorS,
    stage,
    audio,
    beats,
    camera,
    scene: input.scene,
  });
}
