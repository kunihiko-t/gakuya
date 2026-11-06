import type { Knob } from '../shared/types.ts';

/** How finely a slider moves. */
export const STEPS = 1000;

type Scale = Pick<Knob, 'min' | 'max' | 'scale'>;

export function sliderToValue(k: Scale, pos: number): number {
  const u = pos / STEPS;
  return k.scale === 'log' ? k.min * Math.pow(k.max / k.min, u) : k.min + (k.max - k.min) * u;
}

export function valueToSlider(k: Scale, value: number): number {
  const u = k.scale === 'log' ? Math.log(value / k.min) / Math.log(k.max / k.min) : (value - k.min) / (k.max - k.min);
  return u * STEPS;
}

function nearest(f: number, beats: number[]): number {
  return beats.reduce((best, b) => (Math.abs(b - f) < Math.abs(best - f) ? b : best));
}

/** Both ends on the nearest beat. A range never collapses to one beat: it takes the next one, or the one before at the end. */
export function snapRange(range: [number, number], beats: number[]): [number, number] {
  if (beats.length < 2) return range;
  const a = nearest(range[0], beats), b = nearest(range[1], beats);
  if (a !== b) return [a, b];
  const i = beats.indexOf(a);
  return i + 1 < beats.length ? [a, beats[i + 1]] : [beats[i - 1], a];
}
