// Director timeline: typed cues on tracks, played against a clock (the synced
// render's audio clock, or a preview clock). Camera cues are *moves* to a target
// framing eased over their duration; motion cues fire once at their start;
// narration blocks mark spoken sentences (timed from the synthesized audio);
// audio cues schedule background music/SFX with volume + fade envelopes.
export type TrackKind = 'narration' | 'camera' | 'motion' | 'audio';

// A camera framing: [posX,posY,posZ, targetX,targetY,targetZ, fov]. Serializable.
export type PoseTuple = [number, number, number, number, number, number, number];

export interface Cue {
  id: string;
  track: TrackKind;
  type: string; // catalog key, e.g. 'cam.anchor', 'motion.point', 'cam.custom', 'cam.path'
  start: number; // seconds
  duration: number; // seconds (camera = ease time; motion = block length, visual)
  pose?: PoseTuple; // captured framing (cam.custom) — ease to this instead of a preset
  path?: { t: number; p: PoseTuple }[]; // recorded camera move (cam.path) — replayed

  // Narration blocks (generated from the script; timing comes from the audio).
  text?: string; // the spoken sentence (TTS strips the [tags])
  gesture?: string; // resolved gesture for this sentence
  emotion?: string; // resolved emotion for this sentence

  // Background-audio cues.
  label?: string; // display name (filename / "music")
  src?: string; // a URL (persisted across save/load); file uploads are session-only
  volume?: number; // 0..1 base gain (default 0.8)
  fadeIn?: number; // seconds (default 0)
  fadeOut?: number; // seconds (default 1.0)
}

export interface Timeline {
  duration: number; // seconds
  cues: Cue[];
}

export function emptyTimeline(duration = 20): Timeline {
  return { duration, cues: [] };
}

let counter = 0;
export function cueId(): string {
  counter += 1;
  return `cue_${counter}`;
}
