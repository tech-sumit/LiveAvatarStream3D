import type { FingerCurls } from './types.js';
import { notImplemented } from './_stub.js';

/** Finger curls for counting 1→n at normalized phase `t`; writes into reused `out`. */
export function fingerCount(
  n: number,
  t: number,
  opts?: { phase?: number; curl?: number[] },
  out?: FingerCurls,
): FingerCurls {
  return notImplemented('fingerCount', { n, t, opts, out });
}
