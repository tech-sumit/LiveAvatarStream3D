import type { Composition, Pose, Subject } from './types.js';
import { composeShot } from './composeShot.js';

// ── The shot-preset catalog ─────────────────────────────────────────────────
//
// One DATA table of named camera framings, resolved against the LIVE subjects
// (the anchor head, the video-wall screen) by `sampleShot`. This is the single
// source of truth the studio's #shot dropdown AND the newscast cam cues both
// read — "direction as data": adding a framing is a row here, not engine code.
//
// The fixed set: the anchor stands at the origin facing +Z (toward the camera);
// the screen sits to the anchor's right at SCREEN_STAND_POS ≈ (1.95, 1.62, −0.35).
// Each preset says which subject(s) to frame, how tight (size), and any orbit
// (azimuth/elevation), lens, dutch roll, follow, or time-based move.

/** Which live subject(s) a preset frames. The studio resolves these to `Subject[]`. */
export type ShotSubject = 'anchor' | 'screen' | 'both';

/** A time-based camera move. `push-in` dollies tighter by interpolating numeric size. */
export interface ShotMove {
  kind: 'push-in';
  fromSize: number; // head-heights of distance at t = 0
  toSize: number; // head-heights at t = durationSec
  durationSec: number;
}

export interface ShotPreset {
  id: string;
  label: string;
  subject: ShotSubject;
  composition: Composition;
  move?: ShotMove;
}

// Note: close/medium/wide reuse the named SIZE_TABLE presets, so they are byte-for-byte
// the existing cue framings (cu/medium/wide) — unifying the live dropdown onto the same
// numbers retires the second, hardcoded `stage.frame()` system. The angle/size numbers on
// the new presets are starting points, tuned against real preview renders.
export const CAMERA_SHOTS: Record<string, ShotPreset> = {
  close: { id: 'close', label: 'Close-up', subject: 'anchor', composition: { size: 'cu' } },
  medium: { id: 'medium', label: 'Medium (anchor)', subject: 'anchor', composition: { size: 'medium' } },
  wide: { id: 'wide', label: 'Wide (studio)', subject: 'anchor', composition: { size: 'wide' } },
  'two-shot': { id: 'two-shot', label: 'Two-shot + screen', subject: 'both', composition: { follow: true } },
  'ots-screen': {
    id: 'ots-screen',
    label: 'Over-the-shoulder',
    subject: 'screen',
    // Camera in FRONT of the wall (the anchor's side) but swung toward the anchor's line and
    // pulled back, so the screen content faces camera and the anchor's near shoulder frames the
    // foreground (a true over-the-shoulder, not a bare wall card).
    composition: { size: 6.5, azimuth: -18, elevation: -2, lens: 46, balance: -1.4 },
  },
  profile: { id: 'profile', label: 'Profile ¾', subject: 'anchor', composition: { size: 5.0, azimuth: 40, lens: 34 } },
  'hero-low': { id: 'hero-low', label: 'Hero (low)', subject: 'anchor', composition: { size: 6.0, elevation: -12, lens: 30 } },
  dutch: { id: 'dutch', label: 'Dutch tilt', subject: 'anchor', composition: { size: 5.0, azimuth: 8, roll: 6, lens: 36 } },
  establish: { id: 'establish', label: 'Establish', subject: 'both', composition: { lens: 50, azimuth: 25, elevation: 18 } },
  'push-in': {
    id: 'push-in',
    label: 'Push-in',
    subject: 'anchor',
    composition: { size: 7.0, lens: 32 },
    move: { kind: 'push-in', fromSize: 7.0, toSize: 4.2, durationSec: 3 },
  },
};

/** Stable catalog id list (the DSL enum re-exported by @las/protocol; dropdown order). */
export const CAMERA_SHOT_IDS = [
  'close',
  'medium',
  'wide',
  'two-shot',
  'ots-screen',
  'profile',
  'hero-low',
  'dutch',
  'establish',
  'push-in',
] as const;

export type CameraShotId = (typeof CAMERA_SHOT_IDS)[number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
// Smoothstep ease so a push-in starts and ends gently rather than snapping.
const easeInOut = (u: number): number => u * u * (3 - 2 * u);

// Reused composition scratch for moves (rule C) — fully consumed by composeShot each call.
const _moveComp: Composition = {};

/**
 * Resolve a preset to a concrete camera Pose at time `tSec` into the shot, framing the
 * already-resolved `subjects` (anchor head, screen — the studio maps `preset.subject` to
 * these). Static presets ignore `tSec`; a `push-in` interpolates its numeric size. A
 * `follow` preset has no special branch here — it simply gets re-called per-frame with
 * the updated live subjects. Pass `out` to reuse a Pose buffer on the per-frame path.
 */
export function sampleShot(preset: ShotPreset, subjects: Subject[], tSec: number, out?: Pose): Pose {
  const move = preset.move;
  if (move && move.kind === 'push-in') {
    const u = move.durationSec > 0 ? clamp01(tSec / move.durationSec) : 1;
    const size = move.fromSize + (move.toSize - move.fromSize) * easeInOut(u);
    Object.assign(_moveComp, preset.composition);
    _moveComp.size = size;
    return composeShot(subjects, _moveComp, out);
  }
  return composeShot(subjects, preset.composition, out);
}
