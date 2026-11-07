import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/** Headless Chrome has no real output device, so a sound's clock there never lags. This stands in for headphones. */
let clock = 0;
class DelayedAudio {
  static delay = 0;
  static last: DelayedAudio;
  preload = '';
  paused = true;
  duration = 60;
  seeks = 0;
  private rate = 1;
  private base = 0;
  private startedAt = 0;
  private src_ = '';
  constructor() { DelayedAudio.last = this; }
  addEventListener(): void {}
  getAttribute(): string { return this.src_; }
  removeAttribute(): void { this.src_ = ''; }
  load(): void {}
  set src(v: string) { this.src_ = v; }
  get seeking(): boolean { return false; }
  get playbackRate(): number { return this.rate; }
  set playbackRate(v: number) {
    // Measured in Chrome: changing the speed does not end the wait after a seek.
    if (clock >= this.startedAt + DelayedAudio.delay) { this.base = this.currentTime; this.startedAt = clock - DelayedAudio.delay; }
    this.rate = v;
  }
  get currentTime(): number {
    return this.paused ? this.base : this.base + Math.max(0, clock - this.startedAt - DelayedAudio.delay) * this.rate;
  }
  set currentTime(v: number) { this.seeks++; this.base = v; this.startedAt = clock; }
  play(): Promise<void> { this.paused = false; this.startedAt = clock; return Promise.resolve(); }
  pause(): void { this.base = this.currentTime; this.paused = true; }
}

const { Sound } = await (async () => {
  (globalThis as any).Audio = DelayedAudio;
  (globalThis as any).window = globalThis;
  return import('../src/web/sound.ts');
})();

/** Plays for a while on a picture that runs perfectly; returns the seeks and the final gap in the sound's clock. */
function play(delay: number, seconds: number, offset = 0): { seeks: number; drift: number; audio: DelayedAudio } {
  DelayedAudio.delay = delay;
  const cbs: ((playing: boolean) => void)[] = [];
  const video = { muted: false, get currentTime() { return clock; } };
  const viewer: any = { playing: false, video, source: { timeOf: () => 0 }, onPlay: (cb: (p: boolean) => void) => cbs.push(cb) };
  const sound = new Sound(viewer, () => {});
  sound.set('x.wav', offset);
  viewer.playing = true;
  for (const cb of cbs) cb(true);
  for (let i = 0; i < seconds * 100; i++) { clock += 0.01; mock.timers.tick(10); }
  const a = DelayedAudio.last;
  return { seeks: a.seeks, drift: clock + offset - a.currentTime, audio: a };
}

beforeEach(() => { clock = 0; mock.timers.enable({ apis: ['setInterval', 'Date'] }); });
afterEach(() => { mock.timers.reset(); });

test('slow headphones do not make the sound seek over and over', () => {
  const r = play(0.3, 10);
  assert.ok(r.seeks <= 2, `${r.seeks} seeks in 10 seconds`);
  assert.ok(Math.abs(r.drift) < 0.12, `drift ${r.drift}`);
});

test('without a delay the sound seeks only to start', () => {
  const r = play(0, 10);
  assert.equal(r.seeks, 1);
  assert.ok(Math.abs(r.drift) < 0.05, `drift ${r.drift}`);
});

test('the sound still catches up when it really falls behind', () => {
  const r = play(0, 3);
  r.audio.currentTime = 0.5; // what a stall in the sound looks like to the next check
  const before = r.audio.seeks;
  for (let i = 0; i < 300; i++) { clock += 0.01; mock.timers.tick(10); }
  assert.ok(r.audio.seeks > before, 'it seeked');
  assert.ok(Math.abs(clock - r.audio.currentTime) < 0.12, `drift ${clock - r.audio.currentTime}`);
});
