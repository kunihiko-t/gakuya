import type { Viewer } from './viewer.ts';

const CHECK_MS = 100;
const MAX_DRIFT = 0.12;
const MAX_RATE_CHANGE = 0.05;
// A sound's clock stands still after a seek until the output device has caught up, which takes a while on headphones.
const SETTLE_MS = 500;

/** Plays another sound in place of the video's own, on the video's clock. The picture never waits for it. */
export class Sound {
  readonly audio = new Audio();
  offset = 0;
  private timer = 0;
  /** How far ahead to seek so the sound lands on time once the output device has caught up. */
  private lead = 0;
  private seekedAt = -Infinity;
  private learning = false;

  constructor(private viewer: Viewer, private onUnreadable: () => void) {
    this.audio.preload = 'auto';
    this.audio.addEventListener('error', () => {
      if (!this.audio.getAttribute('src')) return;
      this.set(null, 0);
      this.onUnreadable();
    });
    viewer.onPlay((playing) => {
      clearInterval(this.timer);
      if (playing && this.audio.getAttribute('src')) this.timer = window.setInterval(() => this.follow(), CHECK_MS);
      if (playing) this.follow();
      else this.quiet();
    });
  }

  /** null gives the sound back to the video. */
  set(url: string | null, offsetSeconds: number): void {
    const playing = this.viewer.playing;
    clearInterval(this.timer);
    this.quiet();
    this.offset = offsetSeconds;
    this.viewer.video.muted = !!url;
    if (url) this.audio.src = url;
    else { this.audio.removeAttribute('src'); this.audio.load(); }
    if (url && playing) this.timer = window.setInterval(() => this.follow(), CHECK_MS);
  }

  private quiet(): void {
    this.audio.pause();
    this.audio.playbackRate = 1;
  }

  private follow(): void {
    const src = this.viewer.source, a = this.audio;
    if (!src || !a.getAttribute('src')) return;
    const t = this.viewer.video.currentTime - src.timeOf(0) + this.offset;
    if (t < 0 || (Number.isFinite(a.duration) && t >= a.duration)) { this.quiet(); return; }
    if (a.paused) {
      this.jump(t);
      a.play().catch(() => {});
      return;
    }
    if (a.seeking || Date.now() - this.seekedAt < SETTLE_MS) return;
    const drift = t - a.currentTime;
    if (this.learning) {
      this.learning = false;
      this.lead = Math.max(0, this.lead + drift);
    }
    // A seek makes the sound hitch, so only a large gap gets one. A change of speed this small cannot be heard.
    if (Math.abs(drift) > MAX_DRIFT) this.jump(t);
    else a.playbackRate = 1 + Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, drift));
  }

  private jump(t: number): void {
    this.audio.playbackRate = 1;
    this.audio.currentTime = t + this.lead;
    this.seekedAt = Date.now();
    this.learning = true;
  }
}
