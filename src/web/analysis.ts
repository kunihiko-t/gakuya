// Beat and motion analysis. Pure functions: no DOM, no audio APIs.

const HOP = 512;
const WAVE_POINTS = 2000;

/** Rise in log energy per hop: spikes where something starts. */
function onsetEnvelope(samples: Float32Array): Float32Array {
  const n = Math.floor(samples.length / HOP);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) e += samples[j] * samples[j];
    const log = Math.log1p(e * 100);
    env[i] = Math.max(0, log - prev);
    prev = log;
  }
  return env;
}

function waveform(samples: Float32Array): Float32Array {
  const points = Math.max(1, Math.min(WAVE_POINTS, Math.ceil(samples.length / HOP)));
  const out = new Float32Array(points);
  const step = samples.length / points;
  let peak = 0;
  for (let i = 0; i < points; i++) {
    let m = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, Math.abs(samples[j]));
    out[i] = m;
    peak = Math.max(peak, m);
  }
  if (peak > 0) for (let i = 0; i < points; i++) out[i] /= peak;
  return out;
}

const lerpAt = (a: ArrayLike<number>, x: number) => {
  const i = Math.floor(x), f = x - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : (a[i] ?? 0);
};

/**
 * Tempo by autocorrelation of the onset envelope, searched over 60..200 BPM. Harmonics of a beat score alike, so a
 * mild preference for 120 settles them.
 */
export function analyzeAudio(samples: Float32Array, rate: number): { bpm: number | null; offset: number; wave: Float32Array } {
  const wave = waveform(samples);
  const env = onsetEnvelope(samples);
  const hopSec = HOP / rate;
  const none = { bpm: null, offset: 0, wave };
  let energy = 0;
  for (const v of env) energy += v * v;
  if (energy < 1e-6) return none;

  const multiples = 4;
  const maxLag = Math.min(env.length - 1, Math.ceil(((60 / 60) * multiples) / hopSec));
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s;
  }

  let best = 0, bestScore = 0;
  for (let bpm = 60; bpm <= 200; bpm += 0.1) {
    const lag = 60 / bpm / hopSec;
    let s = 0;
    for (let k = 1; k <= multiples; k++) if (k * lag <= maxLag) s += lerpAt(ac, k * lag);
    s *= Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  if (!best || bestScore / (multiples * energy) < 0.05) return none;

  // A small tempo error drifts over a whole song and drags the phase with it, so fit the two together.
  let bpm = best, offset = 0, fit = -1;
  for (let candidate = best - 1.5; candidate <= best + 1.5; candidate += 0.02) {
    const period = 60 / candidate;
    for (let t = 0; t < period; t += hopSec / 2) {
      let score = 0;
      for (let b = t; b / hopSec < env.length - 1; b += period) score += lerpAt(env, b / hopSec);
      if (score > fit) { fit = score; bpm = candidate; offset = t; }
    }
  }
  return { bpm: Math.round(bpm * 100) / 100, offset, wave };
}

/** Beat times inside 0..duration. The offset may be negative or beyond one beat. */
export function beatTimes(bpm: number, offset: number, duration: number): number[] {
  const period = 60 / bpm;
  const first = offset - Math.floor(offset / period) * period;
  const out: number[] = [];
  for (let i = 0; first + i * period < duration; i++) out.push(first + i * period);
  return out;
}

/** Mean absolute change of each small gray frame from the one before, 0..1. */
export function motionFromGray(frames: Iterable<Uint8Array>): Float32Array {
  const out: number[] = [];
  let prev: Uint8Array | null = null;
  for (const f of frames) {
    let sum = 0;
    if (prev) for (let i = 0; i < f.length; i++) sum += Math.abs(f[i] - prev[i]);
    out.push(prev && f.length ? sum / f.length / 255 : 0);
    prev = f;
  }
  return Float32Array.from(out);
}

function median(values: ArrayLike<number>): number {
  const s = Array.from(values).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** Below this, a change is sensor or compression noise. */
const NOISE_FLOOR = 0.002;
const CUT_RATIO = 8;
const CUT_MIN = 0.1;
const MIN_GAP_SEC = 0.15;

/**
 * Cuts are isolated spikes in motion. Onsets are where motion rises out of a lull: the frame that first passes the low
 * threshold, once the curve has gone on to the high one. Thresholds follow a two-second window, so they work for both
 * a slow sway and a hard dance.
 */
export function findOnsets(motion: Float32Array, fps: number): { onsets: number[]; cuts: number[] } {
  const med = median(motion);
  const cuts: number[] = [];
  const clean = Float32Array.from(motion);
  for (let i = 1; i < motion.length; i++) {
    const before = motion[i - 1], after = motion[i + 1] ?? before;
    if (motion[i] >= CUT_MIN && motion[i] >= CUT_RATIO * Math.max(med, before, after, NOISE_FLOOR)) {
      cuts.push(i);
      clean[i] = (before + after) / 2;
    }
  }

  const half = Math.round(fps);
  const minGap = Math.ceil(MIN_GAP_SEC * fps);
  const onsets: number[] = [];
  let lull = true;
  let rise = -1;
  for (let i = 0; i < clean.length; i++) {
    const window = Array.from(clean.subarray(Math.max(0, i - half), i + half + 1)).sort((a, b) => a - b);
    const lo = window[Math.floor(window.length * 0.2)], hi = window[window.length - 1];
    const span = hi - lo;
    if (hi < NOISE_FLOOR) { lull = true; rise = -1; continue; }
    const low = lo + span * 0.2, high = lo + span * 0.6;
    if (clean[i] <= low) { lull = true; rise = -1; continue; }
    if (!lull) continue;
    if (rise < 0) rise = i;
    if (clean[i] >= high) {
      if (!onsets.length || rise - onsets[onsets.length - 1] >= minGap) onsets.push(rise);
      lull = false;
      rise = -1;
    }
  }
  return { onsets, cuts };
}
