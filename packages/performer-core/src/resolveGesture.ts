import type { Drive, GestureKind, GestureParams } from './types.js';
import { notImplemented } from './_stub.js';

/** Pure (no module state): resolve a gesture kind + params to a Drive (clip/ik), incl. baseEnergy. */
export function resolveGesture(kind: GestureKind, params?: GestureParams): Drive {
  return notImplemented('resolveGesture', { kind, params });
}
