import type { FingerCurls } from './types.js';

// applyCounting constants (avatarController.ts:75-76): per-joint curl folding a finger into the
// palm about its local X (negative = fold), and the seconds each of 1/2/3 is shown.
const FINGER_CURL = [-1.0, -1.45, -1.2];
const COUNT_PHASE = 0.75;
const FINGERS = 4; // index, middle, ring, pinky (pinky stays curled)

/**
 * Finger curls for counting up to `n` at elapsed time `t` (seconds), pure & frame-stateless.
 *
 * The displayed count ramps `1 → 2 → 3` exactly as applyCounting does — `t<phase?1 : t<2·phase?2
 * : 3` (avatarController.ts:596) — capped at the requested `n`. Each finger that is "up" extends
 * (joint rotation 0); each finger still down folds to `curl[j]`, i.e. `curl[j]·(1-ext)` with
 * `ext∈{0,1}` here (the avatar-live adapter applies the per-frame smoothing of `ext`). Returns
 * `curls[finger][joint]`. Out-param overload (cross-cutting rule C) — writes into reused `out`.
 */
export function fingerCount(
  n: number,
  t: number,
  opts?: { phase?: number; curl?: number[] },
  out?: FingerCurls,
): FingerCurls {
  const phase = opts?.phase ?? COUNT_PHASE;
  const curl = opts?.curl ?? FINGER_CURL;
  const joints = curl.length;

  // Displayed count ramps with time, never exceeding the requested total.
  const ramp = t < phase ? 1 : t < 2 * phase ? 2 : 3;
  const shown = Math.min(n, ramp);

  // up[finger]: index up at ≥1, middle at ≥2, ring at ≥3; pinky always curled.
  const result: number[][] = out ? out.curls : [];
  for (let f = 0; f < FINGERS; f++) {
    const up = f === 0 ? shown >= 1 : f === 1 ? shown >= 2 : f === 2 ? shown >= 3 : false;
    const ext = up ? 1 : 0;
    const row = result[f] ?? [];
    for (let j = 0; j < joints; j++) {
      const c = curl[j] ?? 0;
      row[j] = c * (1 - ext);
    }
    row.length = joints;
    result[f] = row;
  }
  result.length = FINGERS;

  if (out) {
    out.curls = result;
    return out;
  }
  return { curls: result };
}
