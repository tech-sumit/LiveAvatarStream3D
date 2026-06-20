// Director timeline: typed cues on tracks, played against a clock (the synced
// render's audio clock, or a preview clock). Camera cues are *moves* to a target
// framing eased over their duration; motion cues fire once at their start.
export type TrackKind = 'camera' | 'motion';

export interface Cue {
  id: string;
  track: TrackKind;
  type: string; // catalog key, e.g. 'cam.anchor', 'motion.point'
  start: number; // seconds
  duration: number; // seconds (camera = ease time; motion = block length, visual)
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
