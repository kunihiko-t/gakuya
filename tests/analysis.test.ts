import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, beatTimes, findOnsets, motionFromGray } from '../src/web/analysis.ts';

const RATE = 48000;
function clicks(bpm: number, offset: number, seconds: number): Float32Array {
  const s = new Float32Array(seconds * RATE);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const at = Math.round(t * RATE);
    for (let i = 0; i < 480 && at + i < s.length; i++) s[at + i] = Math.sin((2 * Math.PI * 2000 * i) / RATE);
  }
  return s;
}
const phaseError = (got: number, want: number, bpm: number) => {
  const beat = 60 / bpm, d = ((got - want) % beat + beat) % beat;
  return Math.min(d, beat - d);
};

for (const [bpm, offset] of [[120, 0.25], [90, 0.4], [128, 0.18], [150, 0.1]] as const) {
  test(`${bpm} BPM clicks starting at ${offset}s are found`, () => {
    const r = analyzeAudio(clicks(bpm, offset, 20), RATE);
    assert.ok(r.bpm !== null && Math.abs(r.bpm - bpm) <= 1, `bpm ${r.bpm}`);
    assert.ok(phaseError(r.offset, offset, bpm) <= 0.02, `offset ${r.offset}`);
    assert.ok(r.wave.length > 100 && r.wave.length <= 4000);
    assert.ok(Math.max(...r.wave) <= 1 && Math.max(...r.wave) > 0.5);
  });
}

test('silence has no tempo and does not throw', () => {
  const r = analyzeAudio(new Float32Array(RATE * 5), RATE);
  assert.equal(r.bpm, null);
  assert.equal(analyzeAudio(new Float32Array(0), RATE).bpm, null);
});

test('beatTimes lays out beats from the offset to the end', () => {
  assert.deepEqual(beatTimes(120, 0.25, 1.5), [0.25, 0.75, 1.25]);
  assert.deepEqual(beatTimes(120, -0.25, 1), [0.25, 0.75]);
});

test('motionFromGray is the mean change per frame', () => {
  const a = new Uint8Array(100), b = new Uint8Array(100).fill(255), c = new Uint8Array(100).fill(255);
  c.fill(0, 0, 50);
  const m = motionFromGray([a, a, b, c]);
  assert.deepEqual([...m].map((v) => +v.toFixed(2)), [0, 0, 1, 0.5]);
});

function curve(parts: [number, number][]): Float32Array {
  const out: number[] = [];
  for (const [n, v] of parts) for (let i = 0; i < n; i++) out.push(v);
  return Float32Array.from(out);
}

test('still, then moving, then still: the start of the move is an onset', () => {
  const { onsets, cuts } = findOnsets(curve([[30, 0], [30, 0.04], [30, 0], [30, 0.04]]), 30);
  assert.deepEqual(cuts, []);
  assert.equal(onsets.length, 2);
  assert.ok(Math.abs(onsets[0] - 30) <= 1 && Math.abs(onsets[1] - 90) <= 1, `onsets ${onsets}`);
});

test('a cut is reported as a cut and not as an onset', () => {
  const m = curve([[40, 0.03], [1, 0.9], [40, 0.03]]);
  const { onsets, cuts } = findOnsets(m, 30);
  assert.deepEqual(cuts, [40]);
  assert.deepEqual(onsets.filter((f) => Math.abs(f - 40) <= 1), []);
});

test('sensor noise alone gives no onsets', () => {
  let seed = 1;
  const noise = Float32Array.from({ length: 200 }, () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 0.001; });
  assert.deepEqual(findOnsets(noise, 30).onsets, []);
});

test('onsets are at least 0.15 seconds apart', () => {
  const parts: [number, number][] = [];
  for (let i = 0; i < 10; i++) parts.push([2, 0], [2, 0.05]);
  const { onsets } = findOnsets(curve(parts), 30);
  for (let i = 1; i < onsets.length; i++) assert.ok(onsets[i] - onsets[i - 1] >= 0.15 * 30 - 1e-9);
});
