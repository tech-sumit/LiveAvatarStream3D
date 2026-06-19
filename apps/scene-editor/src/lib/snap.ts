import type { Transform } from '@las/protocol';

export function snapValue(v: number, step: number): number {
  if (step <= 0) return v;
  return Math.round(v / step) * step;
}

export function snapTransform(t: Transform, step: number): Transform {
  return {
    position: t.position.map((v) => snapValue(v, step)) as Transform['position'],
    rotation: t.rotation.map((v) => snapValue(v, step)) as Transform['rotation'],
    scale: t.scale.map((v) => snapValue(v, step * 0.1 || 0.1)) as Transform['scale'],
  };
}
