// Director timeline: typed cues on tracks, played against a clock (the synced
// render's audio clock, or a preview clock). Camera cues are *moves* to a target
// framing eased over their duration; motion cues fire once at their start.
export type TrackKind = 'camera' | 'motion';

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
