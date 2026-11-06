const BASE_WINDOW = 0.18;
const MOTION_WINDOW = 0.12;

/** Brightness at `time`: 1 on a mark, fading to 0 over `windowSec`. `marks` must be sorted. */
export function markAt(marks: number[], time: number, windowSec: number): number {
  let lo = 0, hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid] <= time) lo = mid + 1; else hi = mid;
  }
  return lo ? Math.max(0, 1 - (time - marks[lo - 1]) / windowSec) : 0;
}

/** A ring in the padding around the picture: warm for what the moves should follow, blue for where they start. */
export class Flash {
  enabled = true;
  base: number[] = [];
  motion: number[] = [];
  private last = 0;

  constructor(private el: HTMLElement) {}

  setMarks(base: number[], motion: number[]): void {
    this.base = base;
    this.motion = motion;
    this.update(this.last);
  }

  update(time: number): void {
    this.last = time;
    const b = this.enabled ? markAt(this.base, time, BASE_WINDOW) : 0;
    const m = this.enabled ? markAt(this.motion, time, MOTION_WINDOW) : 0;
    this.el.dataset.base = String(b);
    this.el.dataset.motion = String(m);
    this.el.style.boxShadow = b || m ? `inset 0 0 0 3px rgba(79,195,247,${m}), inset 0 0 0 6px rgba(255,176,32,${b})` : 'none';
  }
}
