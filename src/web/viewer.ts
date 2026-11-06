import type { Pt } from '../shared/types.ts';
import { FrameSource } from './frames.ts';
import { t } from './strings.ts';

export interface Zoom { scale: number; x: number; y: number }

const STALE_FRAME_SEC = 0.25;

/** One picture: <video> while playing, an exact decoded frame on a canvas while stopped. */
export class Viewer {
  source: FrameSource | null = null;
  /** The frame last put on screen. */
  frame = 0;
  /** The frame being asked for; ahead of `frame` while a decode is running. */
  target = 0;
  playing = false;
  zoom: Zoom = { scale: 1, x: 0, y: 0 };
  /** Set by the owner while the pan key is held. */
  panKey = false;
  /** True if the pan key has moved the picture since it went down. */
  panned = false;

  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlay: SVGSVGElement;
  private ctx: CanvasRenderingContext2D;
  private messageEl: HTMLElement;
  private frameCbs: ((f: number) => void)[] = [];
  private zoomCbs: ((z: Zoom) => void)[] = [];
  private playCbs: ((playing: boolean) => void)[] = [];
  private drawn = -1;
  drawing: Promise<void> | null = null;
  private lastMedia = 0;
  private frameCallback = 0;

  constructor(readonly el: HTMLElement) {
    this.viewport = document.createElement('div');
    this.viewport.className = 'viewport';
    this.content = document.createElement('div');
    this.content.className = 'content';
    this.video = document.createElement('video');
    this.video.preload = 'auto';
    this.video.playsInline = true;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'picture';
    this.canvas.dataset.state = 'loading';
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('viewBox', '0 0 1 1');
    this.overlay.setAttribute('preserveAspectRatio', 'none');
    this.messageEl = document.createElement('div');
    this.messageEl.className = 'message';
    this.messageEl.hidden = true;
    this.content.append(this.video, this.canvas, this.overlay);
    this.viewport.append(this.content, this.messageEl);
    const glow = document.createElement('div');
    glow.className = 'frame-glow';
    glow.append(this.viewport);
    el.append(glow);

    this.video.addEventListener('ended', () => { void this.pause(); });
    new ResizeObserver(() => this.layout()).observe(this.viewport);
    this.viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.viewport.addEventListener('pointerdown', (e) => this.onPanStart(e));
  }

  /** Empties the pane so nothing stale shows. */
  clear(): void {
    this.source?.close();
    this.source = null;
    this.drawn = -1;
    this.video.removeAttribute('src');
    this.video.load();
  }

  /** The glow element around the picture. */
  get frameGlow(): HTMLElement { return this.viewport.parentElement!; }

  onFrame(cb: (f: number) => void): void { this.frameCbs.push(cb); }
  onZoom(cb: (z: Zoom) => void): void { this.zoomCbs.push(cb); }
  onPlay(cb: (playing: boolean) => void): void { this.playCbs.push(cb); }

  /** Replaces the video. Throws nothing: an unplayable file becomes a message on the picture. */
  async open(url: string): Promise<boolean> {
    this.source?.close();
    this.source = null;
    this.drawn = -1;
    this.showMessage(null);
    try {
      this.source = await FrameSource.open(url);
    } catch {
      this.showMessage(t.cannotPlay);
      return false;
    }
    this.canvas.width = this.source.width;
    this.canvas.height = this.source.height;
    this.video.src = url;
    this.layout();
    await this.seek(Math.min(this.target, this.source.frames - 1));
    return true;
  }

  showMessage(text: string | null, info = false): void {
    this.messageEl.hidden = text === null;
    this.messageEl.textContent = text ?? '';
    this.messageEl.classList.toggle('info', info);
  }

  /** Shows `frame` exactly. Fast repeated calls collapse to the latest. */
  seek(frame: number): Promise<void> {
    if (!this.source) return Promise.resolve();
    this.target = Math.max(0, Math.min(this.source.frames - 1, frame));
    this.drawing ??= this.drawLoop().finally(() => { this.drawing = null; });
    return this.drawing;
  }

  step(delta: number): Promise<void> {
    if (this.playing) return this.pause().then(() => this.seek(this.target + delta));
    return this.seek(this.target + delta);
  }

  private async drawLoop(): Promise<void> {
    while (this.source && this.drawn !== this.target) {
      const f = this.target, source = this.source;
      try {
        await source.draw(f, this.ctx);
      } catch (e) {
        if (this.source === source) throw e;
        return; // the video was replaced under this decode
      }
      if (this.source !== source) return;
      this.drawn = f;
      this.frame = f;
      if (!this.playing) this.canvas.dataset.state = 'still';
      this.video.currentTime = this.source.timeOf(f);
      for (const cb of this.frameCbs) cb(f);
    }
  }

  /** The frame number during playback is an estimate; stopping replaces it with the exact frame. */
  private trackPlayback(): void {
    if (!this.playing || !this.source) return;
    this.frameCallback = this.video.requestVideoFrameCallback((_now, meta) => {
      if (!this.playing || !this.source) return;
      // A frame left over from a seek that has since been replaced says nothing about where playback is.
      if (Math.abs(meta.mediaTime - this.video.currentTime) <= STALE_FRAME_SEC) {
        this.lastMedia = meta.mediaTime;
        this.frame = this.target = this.source.frameAt(meta.mediaTime);
        this.drawn = -1;
        for (const cb of this.frameCbs) cb(this.frame);
      }
      this.trackPlayback();
    });
  }

  async play(): Promise<void> {
    if (this.playing || !this.source) return;
    await this.drawing;
    if (this.frame >= this.source.frames - 1) await this.seek(0);
    this.lastMedia = this.video.currentTime;
    this.playing = true;
    this.canvas.dataset.state = 'playing';
    for (const cb of this.playCbs) cb(true);
    this.trackPlayback();
    await this.video.play().catch(() => {});
  }

  async pause(): Promise<void> {
    if (!this.playing || !this.source) return;
    this.playing = false;
    this.video.cancelVideoFrameCallback(this.frameCallback);
    this.video.pause();
    for (const cb of this.playCbs) cb(false);
    const f = this.video.ended ? this.source.frames - 1 : this.source.frameAt(Math.max(this.lastMedia, this.video.currentTime));
    this.drawn = -1;
    await this.seek(f);
  }

  /** Viewport pixels to 0..1 on the picture, whatever the zoom. */
  toNorm(clientX: number, clientY: number): Pt {
    const r = this.content.getBoundingClientRect();
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height];
  }

  setZoom(z: Zoom, silent = false): void {
    const scale = Math.max(1, Math.min(32, z.scale));
    this.zoom = scale === 1 ? { scale: 1, x: 0, y: 0 } : { scale, x: z.x, y: z.y };
    this.applyZoom();
    if (!silent) for (const cb of this.zoomCbs) cb(this.zoom);
  }

  private applyZoom(): void {
    const { scale, x, y } = this.zoom;
    this.content.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.el.classList.toggle('pixelated', scale >= 2);
  }

  private layout(): void {
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    const vw = this.source?.width ?? 16, vh = this.source?.height ?? 9;
    if (!w || !h) return;
    const s = Math.min(w / vw, h / vh);
    this.content.style.width = `${vw * s}px`;
    this.content.style.height = `${vh * s}px`;
    this.content.style.left = `${(w - vw * s) / 2}px`;
    this.content.style.top = `${(h - vh * s) / 2}px`;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.002);
    const scale = Math.max(1, Math.min(32, this.zoom.scale * k));
    const applied = scale / this.zoom.scale;
    const box = this.content.offsetParent!.getBoundingClientRect();
    const px = e.clientX - box.left - this.content.offsetLeft;
    const py = e.clientY - box.top - this.content.offsetTop;
    this.setZoom({ scale, x: px - (px - this.zoom.x) * applied, y: py - (py - this.zoom.y) * applied });
  }

  private onPanStart(e: PointerEvent): void {
    if (!(this.panKey || e.button === 1)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.viewport.setPointerCapture(e.pointerId);
    this.viewport.classList.add('panning');
    const start = { px: e.clientX, py: e.clientY, x: this.zoom.x, y: this.zoom.y };
    const move = (m: PointerEvent) => {
      this.panned = true;
      if (this.zoom.scale > 1) this.setZoom({ scale: this.zoom.scale, x: start.x + m.clientX - start.px, y: start.y + m.clientY - start.py });
    };
    const up = () => {
      this.viewport.classList.remove('panning');
      this.viewport.removeEventListener('pointermove', move);
      this.viewport.removeEventListener('pointerup', up);
      this.viewport.removeEventListener('pointercancel', up);
    };
    this.viewport.addEventListener('pointermove', move);
    this.viewport.addEventListener('pointerup', up);
    this.viewport.addEventListener('pointercancel', up);
  }
}
