import type { Knob, StreamState } from '../shared/types.ts';
import { post } from './api.ts';
import { STEPS, sliderToValue, valueToSlider } from './knobs.ts';
import { t } from './strings.ts';
import type { Timeline } from './timeline.ts';
import type { Viewer } from './viewer.ts';

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const STALL_MS = 3000;
const DRIFT_FRAMES = 15;
const RESYNC_MS = 2000;

function format(k: Knob, v: number | null): string {
  if (v === null) return t.knobUnset;
  const span = Math.abs(k.max - k.min);
  return v.toFixed(span >= 100 ? 0 : span >= 10 ? 1 : 2);
}

/**
 * The renderer's picture over the video, and the knobs beside it. The video stays underneath playing as usual, so its
 * sound, the timeline and the play button work unchanged; the renderer is told to follow it.
 */
export class Live {
  active = false;
  connected = false;
  private problem: string | null = null;
  private stalled = false;
  private message: string | null = null;
  private knobs: Knob[] = [];
  private knobsRev = -1;
  private values: Record<string, number | null> = {};
  private canvas = document.createElement('canvas');
  private toggle = $('live-toggle') as HTMLButtonElement;
  private problemEl = $('live-problem');
  private panel = $('knobs');
  private rows = document.createElement('div');
  private settleButton = document.createElement('button');
  private said = document.createElement('div');

  private seq = Date.now() % 1e9; // never repeats a number from before a reload of the page
  private shownSeq = -1;
  private enterSeq = 0;
  private seek: number | null = null;
  private sending = false;
  private dirty = false;
  private frameId = 0;
  private lastPicture = 0;
  private lastResync = 0;
  private run = 0;

  constructor(private viewer: Viewer, private timeline: Timeline) {
    this.canvas.className = 'live';
    this.canvas.hidden = true;
    viewer.content.insertBefore(this.canvas, viewer.overlay);

    const title = document.createElement('h4');
    title.textContent = t.knobs;
    this.settleButton.id = 'settle';
    this.settleButton.type = 'button';
    this.settleButton.className = 'primary';
    this.settleButton.textContent = t.settle;
    this.settleButton.addEventListener('click', () => { void this.settle(); this.settleButton.blur(); });
    this.said.className = 'said';
    this.panel.append(title, this.rows, this.settleButton, this.said);

    this.toggle.textContent = t.liveOn;
    this.toggle.addEventListener('click', () => { this.setActive(!this.active); this.toggle.blur(); });

    viewer.onPlay((playing) => {
      if (!this.active) return;
      const r = timeline.range;
      if (playing && r && (viewer.frame < r[0] || viewer.frame > r[1])) { this.jumpTo(r[0]); return; }
      this.send();
    });
    viewer.onFrame((f) => this.onFrame(f));
    timeline.onRange(() => { if (this.active) this.send(); });
    setInterval(() => this.watch(), 500);
  }

  update(s: StreamState): void {
    this.toggle.hidden = !s.live;
    const problem = s.live?.problem || null;
    const back = !!this.problem && !problem;
    this.problem = problem;
    this.problemEl.textContent = problem ?? '';
    this.toggle.disabled = !this.active && !!problem;
    if (s.review.knobsRev !== this.knobsRev) {
      this.knobsRev = s.review.knobsRev;
      this.knobs = s.review.knobs;
      this.values = Object.fromEntries(this.knobs.map((k) => [k.id, k.default]));
      this.renderKnobs();
      if (this.active) this.send();
    }
    this.panel.hidden = !s.live || !this.knobs.length;
    if (back) { // it may have restarted: its picture count starts over, and it has forgotten the values
      this.frameId = 0;
      if (this.active) this.announce();
    }
    this.refresh();
  }

  private setActive(on: boolean): void {
    this.active = on;
    this.canvas.hidden = !on;
    this.toggle.textContent = on ? t.liveOff : t.liveOn;
    this.timeline.snapBeats = on;
    this.announce();
    if (on) void this.pictures();
    this.refresh();
  }

  /** A knob only means something on the renderer's picture, so touching one brings it up. */
  private touched(): void {
    if (this.active) this.send();
    else if (!this.problem) this.setActive(true);
  }

  /** Tells the renderer everything, and waits for a picture that reflects it. */
  private announce(): void {
    this.enterSeq = this.seq + 1;
    this.send();
    this.lastPicture = performance.now();
  }

  /** One request in flight, and the latest values next: a dragged slider must not queue up behind a slow renderer. */
  private send(): void {
    if (this.sending) { this.dirty = true; return; }
    this.sending = true;
    this.dirty = false;
    const values: Record<string, number | null> = {}, rangeValues: Record<string, number | null> = {};
    for (const k of this.knobs) (k.scope === 'range' ? rangeValues : values)[k.id] = this.values[k.id];
    // Every message says where the video is: a renderer reads only the latest, so a jump sent once is lost in a drag.
    const seek = this.seek ?? this.viewer.frame;
    this.seek = null;
    const paused = !this.active || !this.viewer.playing;
    post('/live/knobs', { seq: ++this.seq, values, rangeValues, range: this.timeline.range, paused, seek })
      .catch(() => {})
      .finally(() => {
        this.sending = false;
        if (this.dirty) this.send();
      });
  }

  private async pictures(): Promise<void> {
    const run = ++this.run;
    const ctx = this.canvas.getContext('2d')!;
    while (this.active && run === this.run) {
      try {
        const r = await fetch(`/live/frame?after=${this.frameId}`, { signal: AbortSignal.timeout(5000) });
        if (r.status !== 200) { await sleep(r.status === 204 ? 5 : 300); continue; }
        const id = Number(r.headers.get('X-Frame-Id')), song = Number(r.headers.get('X-Song-Frame'));
        const seq = Number(r.headers.get('X-Knob-Seq'));
        this.frameId = id;
        if (seq < this.enterSeq) { await r.body?.cancel(); continue; } // drawn before we came back: not what is playing now
        const picture = await createImageBitmap(await r.blob());
        if (!this.active || run !== this.run) { picture.close(); return; }
        if (this.canvas.width !== picture.width || this.canvas.height !== picture.height) {
          this.canvas.width = picture.width;
          this.canvas.height = picture.height;
        }
        ctx.drawImage(picture, 0, 0);
        picture.close();
        this.shownSeq = seq;
        this.lastPicture = performance.now();
        this.canvas.dataset.frame = String(song);
        this.connected = true;
        this.resync(song);
      } catch {
        await sleep(300);
      }
    }
  }

  /** The renderer keeps its own clock while playing. Bring it back if it wanders off the sound. */
  private resync(song: number): void {
    if (!this.viewer.playing || Math.abs(song - this.viewer.frame) <= DRIFT_FRAMES) return;
    const now = performance.now();
    if (now - this.lastResync < RESYNC_MS) return;
    this.lastResync = now;
    this.send();
  }

  private onFrame(f: number): void {
    if (!this.active) return;
    if (!this.viewer.playing) { this.send(); return; }
    const r = this.timeline.range;
    if (r && f > r[1]) this.jumpTo(r[0]); // a chosen range repeats. Not on f < r[0]: landing on its start can read as one frame before.
  }

  private jumpTo(f: number): void {
    const source = this.viewer.source;
    if (!source) return;
    this.viewer.video.currentTime = source.timeOf(f);
    this.seek = f;
    this.send();
  }

  private watch(): void {
    const waiting = this.viewer.playing || this.shownSeq !== this.seq;
    const stalled = this.active && waiting && performance.now() - this.lastPicture > STALL_MS;
    if (stalled !== this.stalled) { this.stalled = stalled; this.refresh(); }
  }

  private refresh(): void {
    const trouble = this.problem ?? (this.stalled ? t.liveStalled : null);
    this.settleButton.disabled = !!trouble;
    const message = this.active ? trouble : null;
    if (message !== this.message) { // only ever clears its own words, not the viewer's
      this.message = message;
      this.viewer.showMessage(message);
    }
  }

  private renderKnobs(): void {
    this.rows.replaceChildren(...this.knobs.map((k) => {
      const row = document.createElement('div');
      row.className = 'knob';
      row.dataset.knob = k.id;
      const label = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = k.label;
      const shown = document.createElement('b');
      shown.textContent = format(k, this.values[k.id]);
      label.append(name, shown);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(STEPS);
      slider.setAttribute('aria-label', k.label);
      const place = () => {
        const at = this.values[k.id];
        slider.value = String(at === null ? STEPS / 2 : valueToSlider(k, at));
      };
      place();
      slider.addEventListener('input', () => {
        this.values[k.id] = sliderToValue(k, Number(slider.value));
        shown.textContent = format(k, this.values[k.id]);
        this.touched();
      });
      slider.addEventListener('change', () => slider.blur()); // leave the keys for stepping and playing
      label.append(slider);
      row.append(label);
      if (k.reset) {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = k.reset;
        reset.addEventListener('click', () => {
          this.values[k.id] = null;
          shown.textContent = format(k, null);
          place();
          this.touched();
          reset.blur();
        });
        row.append(reset);
      }
      return row;
    }));
  }

  private async settle(): Promise<void> {
    this.said.textContent = '';
    const range = this.timeline.range;
    try {
      await post('/api/settled', { values: this.values, frames: range, frame: this.viewer.frame });
      this.said.textContent = range ? t.settledRange(range[0], range[1]) : t.settledAll;
    } catch (e) {
      this.said.textContent = (e as Error).message;
    }
  }
}
