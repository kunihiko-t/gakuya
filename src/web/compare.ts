import type { Viewer, Zoom } from './viewer.ts';

const MAX_DRIFT = 0.25;
const MAX_RATE_CHANGE = 0.15;

/** Keeps a second picture in step with the first. The left is the master; frames are matched by time. */
export class Compare {
  offsetSeconds = 0;
  private active = false;
  private sync = 0;
  private cbs: ((f: number | null) => void)[] = [];

  constructor(private left: Viewer, private right: Viewer) {
    left.onFrame((f) => { if (this.active && !left.playing) void this.follow(f); });
    left.onPlay((playing) => { if (this.active) void (playing ? this.startPlay() : this.stopPlay()); });
    const link = (from: Viewer, to: Viewer) => from.onZoom((z: Zoom) => { if (this.active) to.setZoom(z, true); });
    link(left, right);
    link(right, left);
  }

  /** Called with the right frame shown, or null if no frame lies at that time. */
  onRightFrame(cb: (f: number | null) => void): void { this.cbs.push(cb); }

  private emit(f: number | null): void { for (const cb of this.cbs) cb(f); }

  /** Right time for a left frame. Both clocks start at their first frame, so a start offset does not matter. */
  private rightTimeOf(leftFrame: number): number | null {
    return this.left.source ? this.rightTimeAt(this.left.source.timeOf(leftFrame)) : null;
  }

  private rightTimeAt(leftTime: number): number | null {
    const l = this.left.source, r = this.right.source;
    if (!l || !r) return null;
    const t = leftTime - l.timeOf(0) + this.offsetSeconds;
    return t < -1e-6 || t > r.duration + 1 / (r.fps || 30) ? null : t + r.timeOf(0);
  }

  /** Opens the right picture, or empties it with null. Resolves when it shows the matching frame. */
  async setRight(url: string | null, offsetSeconds = 0): Promise<boolean> {
    this.offsetSeconds = offsetSeconds;
    if (!url) {
      this.active = false;
      this.right.clear();
      return true;
    }
    this.active = false;
    this.right.setZoom(this.left.zoom, true);
    if (!(await this.right.open(url))) return false;
    this.active = true;
    await this.follow(this.left.target);
    return true;
  }

  setOffset(seconds: number): Promise<void> {
    this.offsetSeconds = seconds;
    return this.active ? this.follow(this.left.target) : Promise.resolve();
  }

  private async follow(leftFrame: number): Promise<void> {
    const t = this.rightTimeOf(leftFrame);
    if (t === null) { this.right.showMessage('対応するコマがありません', true); this.emit(null); return; }
    this.right.showMessage(null);
    const f = this.right.source!.frameAt(t);
    await this.right.seek(f);
    this.emit(f);
  }

  private async startPlay(): Promise<void> {
    this.right.video.muted = true;
    await this.right.play();
    const tick = () => {
      if (!this.left.playing || !this.active) return;
      const t = this.rightTimeAt(this.left.video.currentTime);
      const v = this.right.video;
      if (t !== null) {
        const drift = t - v.currentTime;
        // A seek makes the picture hitch, so only a large gap gets one. Speed closes the small ones.
        if (Math.abs(drift) > MAX_DRIFT) { v.playbackRate = 1; v.currentTime = t; }
        else v.playbackRate = 1 + Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, drift * 2));
      }
      this.sync = requestAnimationFrame(tick);
    };
    this.sync = requestAnimationFrame(tick);
  }

  private async stopPlay(): Promise<void> {
    cancelAnimationFrame(this.sync);
    this.right.video.playbackRate = 1;
    await this.right.pause();
    // the left settles on its exact frame next; onFrame then aligns the right to it
  }
}
