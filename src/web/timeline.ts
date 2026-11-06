import type { Note } from '../shared/types.ts';
import { t as text } from './strings.ts';

export interface TimelineLayers { wave?: ArrayLike<number>; beats?: number[]; motion?: ArrayLike<number>; onsets?: number[]; cues?: number[] }

const COLORS = { bg: '#22242a', grid: '#383b44', wave: '#5d6370', motion: '#4fc3f7', beat: '#ffb020', cue: '#ff7ab6', range: 'rgba(255,176,32,.28)', ai: 'rgba(79,195,247,.32)', head: '#fff', note: '#ffb020', done: '#7bd88f' };
const DRAG_PX = 4;

/** The bar under the picture. A click seeks; a drag selects a range, roughly. Layer times are in frames. */
export class Timeline {
  range: [number, number] | null = null;
  aiRange: [number, number] | null = null;
  private frame = 0;
  private notes: Note[] = [];
  private layers: TimelineLayers = {};
  private seekCbs: ((f: number) => void)[] = [];
  private rangeCbs: ((r: [number, number] | null) => void)[] = [];
  private scrubCbs: ((down: boolean) => void)[] = [];
  private canvas: HTMLCanvasElement;
  private slider: HTMLInputElement;
  private scrubbing = false;
  private label: HTMLElement;

  constructor(el: HTMLElement, public frames: number) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    this.label = document.createElement('span');
    const help = document.createElement('span');
    help.textContent = '← → で1コマ ／ Space で再生・停止 ／ つまみで移動 ／ 帯をドラッグで範囲 ／ 絵の上はホイールで拡大、Space+ドラッグで移動（再生中も）';
    row.append(this.label, help);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'slider');
    this.canvas.setAttribute('aria-label', 'タイムライン');
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.id = 'seek';
    this.slider.min = '0';
    this.slider.step = '1';
    this.slider.value = '0';
    this.slider.setAttribute('aria-label', 'シークバー');
    this.slider.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      for (const cb of this.scrubCbs) cb(true);
      window.addEventListener('pointerup', () => {
        this.scrubbing = false;
        this.slider.blur(); // leave the keys for stepping and playing
        for (const cb of this.scrubCbs) cb(false);
      }, { once: true });
    });
    this.slider.addEventListener('input', () => { for (const cb of this.seekCbs) cb(Number(this.slider.value)); });
    el.append(row, this.slider, this.canvas);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.updateLabel();
  }

  onSeek(cb: (f: number) => void): void { this.seekCbs.push(cb); }
  onRange(cb: (r: [number, number] | null) => void): void { this.rangeCbs.push(cb); }

  /** The seek bar was grabbed (true) or let go (false). */
  onScrub(cb: (down: boolean) => void): void { this.scrubCbs.push(cb); }

  setFrame(f: number): void {
    this.frame = f;
    this.slider.max = String(this.frames - 1);
    if (!this.scrubbing) this.slider.value = String(f);
    this.draw();
  }
  setNotes(n: Note[]): void { this.notes = n; this.draw(); }
  setLayers(l: TimelineLayers): void { Object.assign(this.layers, l); this.draw(); }
  setRange(r: [number, number] | null): void { this.range = r; this.updateLabel(); this.draw(); for (const cb of this.rangeCbs) cb(r); }
  setAiRange(r: [number, number] | null): void { this.aiRange = r; this.draw(); }

  private updateLabel(): void {
    this.label.textContent = this.range ? text.range(this.range[0], this.range[1]) : text.rangeNone(this.frame);
  }

  private frameAtX(clientX: number): number {
    const r = this.canvas.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(u * (this.frames - 1));
  }

  private onDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const startX = e.clientX, a = this.frameAtX(startX);
    let dragging = false;
    const move = (m: PointerEvent) => {
      if (!dragging && Math.abs(m.clientX - startX) < DRAG_PX) return;
      dragging = true;
      const b = this.frameAtX(m.clientX);
      this.setRange(a <= b ? [a, b] : [b, a]);
      for (const cb of this.seekCbs) cb(b);
    };
    const up = () => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
      if (!dragging) {
        if (this.range) this.setRange(null);
        for (const cb of this.seekCbs) cb(a);
      }
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  private draw(): void {
    const c = this.canvas, dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const x = c.getContext('2d')!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = COLORS.bg;
    x.fillRect(0, 0, w, h);
    const fx = (f: number) => (this.frames > 1 ? (f / (this.frames - 1)) * w : 0);
    const row = h / 2 - 4;

    const span = (r: [number, number], color: string) => { x.fillStyle = color; x.fillRect(fx(r[0]), 0, Math.max(2, fx(r[1]) - fx(r[0])), h); };
    if (this.range) span(this.range, COLORS.range);
    if (this.aiRange) span(this.aiRange, COLORS.ai);

    const bars = (values: ArrayLike<number>, top: number, height: number, color: string) => {
      if (!values.length) return;
      x.fillStyle = color;
      for (let px = 0; px < w; px++) {
        const i = Math.floor((px / w) * values.length), j = Math.max(i + 1, Math.floor(((px + 1) / w) * values.length));
        let peak = 0;
        for (let k = i; k < j && k < values.length; k++) peak = Math.max(peak, values[k]);
        const b = Math.min(1, peak) * height;
        x.fillRect(px, top + height - b, 1, b);
      }
    };
    if (this.layers.wave) bars(this.layers.wave, 8, row, COLORS.wave);
    if (this.layers.motion) bars(this.layers.motion, 8 + row, row, COLORS.motion);

    const ticks = (marks: number[] | undefined, top: number, height: number, color: string, alpha: number) => {
      if (!marks) return;
      x.fillStyle = color;
      x.globalAlpha = alpha;
      for (const m of marks) x.fillRect(Math.round(fx(m)), top, 1, height);
      x.globalAlpha = 1;
    };
    ticks(this.layers.beats, 8, row, COLORS.beat, 0.8);
    ticks(this.layers.cues, 8, h - 8, COLORS.cue, 1);
    ticks(this.layers.onsets, 8 + row, row, COLORS.head, 0.7);

    for (const n of this.notes) {
      x.fillStyle = n.status === 'resolved' ? COLORS.done : COLORS.note;
      x.beginPath();
      x.arc(fx(n.anchor.frame), 5, 4, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = COLORS.head;
    x.fillRect(Math.round(fx(this.frame)), 0, 2, h);
    if (!this.range) this.updateLabel();
  }
}
