import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliderToValue, snapRange, valueToSlider } from '../src/web/knobs.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('a linear slider runs from min on the left to max on the right', () => {
  const k = { min: 0, max: 3, scale: 'linear' as const };
  close(sliderToValue(k, 0), 0);
  close(sliderToValue(k, 500), 1.5);
  close(sliderToValue(k, 1000), 3);
  close(valueToSlider(k, 1.5), 500);
});

test('a log slider spends equal travel on each ratio, and min may be the larger end', () => {
  const k = { min: 32, max: 0.1, scale: 'log' as const };
  close(sliderToValue(k, 0), 32);
  close(sliderToValue(k, 1000), 0.1);
  close(sliderToValue(k, 500), Math.sqrt(3.2));
  close(valueToSlider(k, Math.sqrt(3.2)), 500);
});

test('both ends of a range go to the nearest beat', () => {
  assert.deepEqual(snapRange([13, 47], [0, 15, 30, 45, 60]), [15, 45]);
});

test('a range never collapses onto one beat', () => {
  assert.deepEqual(snapRange([14, 16], [0, 15, 30]), [15, 30]);
  assert.deepEqual(snapRange([29, 31], [0, 15, 30]), [15, 30], 'at the last beat it reaches back');
});

test('without enough beats the range stays as the person drew it', () => {
  assert.deepEqual(snapRange([13, 47], []), [13, 47]);
  assert.deepEqual(snapRange([13, 47], [20]), [13, 47]);
});
