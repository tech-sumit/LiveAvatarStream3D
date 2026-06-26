import type { BaseEnergy, Drive, GestureKind, GestureParams } from './types.js';

// CAMEL-CASE GestureKind (Score/performer-core vocab) → SNAKE_CASE on-disk clip filename.
//
// This is a DELIBERATE duplicate of `@las/protocol`'s presets.ts `GESTURE_KIND_TO_CLIP`:
// performer-core must stay zero-dep (no protocol import), so the casing seam is duplicated here
// and a protocol-side test (Phase 3) asserts the two tables are byte-equal — the duplication
// cannot drift. null = IK-driven (point/count) or no library clip (none/explain use the talk base).
const GESTURE_KIND_TO_CLIP: Record<GestureKind, string | null> = {
  none: null,
  explain: null,
  point: null,
  count: null,
  wave: 'wave',
  present: 'open_palms',
  openPalms: 'open_palms',
  thumbsUp: 'thumbs_up',
  shrug: 'shrug',
  handToChest: 'hand_to_chest',
  clasp: 'hand_to_chest',
  nod: 'nod',
};

// IK-driven gestures (no library clip): the arm aims (point) or the fingers count.
const IK_KIND: Partial<Record<GestureKind, 'aim' | 'count'>> = {
  point: 'aim',
  count: 'count',
};

/**
 * Pure (no module state) mapping `kind` + `params` → a `Drive` descriptor.
 *
 * `point`/`count` → `{ kind:'ik', ik:'aim'|'count' }`; library kinds → `{ kind:'clip', clip }` via
 * `GESTURE_KIND_TO_CLIP`; `none`/`explain` → `{ kind:'none' }`. Every result carries a deterministic
 * `baseEnergy` (the fix for the `gestures.ts:98` module-global `rotation` counter — energy is a
 * returned field, never a global pick). The emotion→energy bucket is applied by the compiler where
 * the beat emotion is known, so here `baseEnergy` is a stable default (`med`) unless an `amount`
 * hint is supplied. Determinism: identical `(kind, params)` → identical `Drive`.
 */
export function resolveGesture(kind: GestureKind, params?: GestureParams): Drive {
  const baseEnergy: BaseEnergy = energyFromAmount(params?.amount);

  const ik = IK_KIND[kind];
  if (ik) return { kind: 'ik', ik, baseEnergy };

  const clip = GESTURE_KIND_TO_CLIP[kind];
  if (clip) return { kind: 'clip', clip, baseEnergy };

  return { kind: 'none', baseEnergy };
}

/** Deterministic energy from an optional intensity hint (0..1): low <0.33, high >0.66, else med. */
function energyFromAmount(amount?: number): BaseEnergy {
  if (amount === undefined) return 'med';
  if (amount < 0.33) return 'low';
  if (amount > 0.66) return 'high';
  return 'med';
}
