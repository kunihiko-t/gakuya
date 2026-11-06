import type { Note, Pt, SnapshotUpload, StreamState } from '../shared/types.ts';
import { post } from './api.ts';
import { t } from './strings.ts';
import type { Timeline } from './timeline.ts';
import type { Viewer } from './viewer.ts';

const SVG = 'http://www.w3.org/2000/svg';
const MAX_EDGE = 1920;
const MARK_COLOR = '#ffb020';
const CLICK_PX = 4;

function shapeElement(shape: Pt[], color: string): SVGElement {
  if (shape.length === 1) {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', String(shape[0][0]));
    c.setAttribute('cy', String(shape[0][1]));
    c.setAttribute('r', '0.03');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', '3');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    return c;
  }
  const p = document.createElementNS(SVG, 'polyline');
  p.setAttribute('points', shape.map(([x, y]) => `${x},${y}`).join(' '));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', '3');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('vector-effect', 'non-scaling-stroke');
  return p;
}

function canvasToBase64(c: HTMLCanvasElement): Promise<string> {
  return new Promise((ok, fail) => c.toBlob(async (b) => {
    if (!b) return fail(new Error('toBlob failed'));
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    ok(btoa(s));
  }, 'image/png'));
}

/** Decodes the frames a note refers to and returns each as a raw and a marked PNG. */
export async function renderSnapshots(viewer: Viewer, frames: [number, number], anchorFrame: number, shape: Pt[]): Promise<SnapshotUpload[]> {
  const src = viewer.source!;
  const k = Math.min(1, MAX_EDGE / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  const x = c.getContext('2d')!;
  const wanted = [...new Set([frames[0], Math.round((frames[0] + frames[1]) / 2), frames[1], anchorFrame])].sort((a, b) => a - b);
  // ponytail: only the frame on screen has a live picture; the other frames of a range stay as the video drew them.
  const live = viewer.content.querySelector<HTMLCanvasElement>('canvas.live:not([hidden])');
  const out: SnapshotUpload[] = [];
  for (const frame of wanted) {
    if (live?.dataset.frame === String(frame)) x.drawImage(live, 0, 0, c.width, c.height);
    else await src.draw(frame, x);
    out.push({ frame, kind: 'raw', data: await canvasToBase64(c) });
    if (shape.length) {
      x.strokeStyle = MARK_COLOR;
      x.lineWidth = Math.max(3, c.width / 240);
      x.lineJoin = 'round';
      x.beginPath();
      if (shape.length === 1) x.arc(shape[0][0] * c.width, shape[0][1] * c.height, c.width * 0.03, 0, Math.PI * 2);
      else shape.forEach(([px, py], i) => (i ? x.lineTo(px * c.width, py * c.height) : x.moveTo(px * c.width, py * c.height)));
      x.stroke();
    }
    out.push({ frame, kind: 'marked', data: await canvasToBase64(c) });
  }
  return out;
}

/** The right-hand column: the composer and the list of notes. */
export class NotesPanel {
  private shape: Pt[] = [];
  private anchorFrame = 0;
  private color: string | null = null;
  private eyedrop = false;
  private selected: string | null = null;
  private notes: Note[] = [];
  private text: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private colorInput: HTMLInputElement;
  private eyedropBtn: HTMLButtonElement;
  private clearColorBtn: HTMLButtonElement;
  private errorEl: HTMLElement;
  private list: HTMLElement;
  private markLayer: SVGGElement;
  private aiLayer: SVGGElement;
  private latest = '';
  private seenProposals = new Set<string>();
  private drafts = new Map<string, string>();
  /** A status line owners may add above the list. */
  readonly head: HTMLElement;

  constructor(el: HTMLElement, private viewer: Viewer, private timeline: Timeline) {
    this.head = document.createElement('div');
    const compose = document.createElement('div');
    compose.className = 'compose';
    const title = document.createElement('h4');
    title.textContent = t.yourNote;
    this.text = document.createElement('textarea');
    this.text.id = 'note-text';
    this.text.placeholder = t.placeholder;
    this.text.setAttribute('aria-label', t.yourNote);
    const row = document.createElement('div');
    row.className = 'row';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = t.color;
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.id = 'note-color';
    this.colorInput.setAttribute('aria-label', t.color);
    this.eyedropBtn = document.createElement('button');
    this.eyedropBtn.type = 'button';
    this.eyedropBtn.id = 'note-eyedrop';
    this.eyedropBtn.textContent = t.eyedrop;
    this.clearColorBtn = document.createElement('button');
    this.clearColorBtn.type = 'button';
    this.clearColorBtn.textContent = t.clearColor;
    this.clearColorBtn.hidden = true;
    row.append(colorLabel, this.colorInput, this.eyedropBtn, this.clearColorBtn);
    this.sendBtn = document.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.id = 'note-send';
    this.sendBtn.className = 'primary';
    this.sendBtn.textContent = t.send;
    this.errorEl = document.createElement('p');
    this.errorEl.className = 'error';
    this.errorEl.hidden = true;
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t.composeHint;
    compose.append(title, this.text, row, this.sendBtn, this.errorEl, hint);
    const listTitle = document.createElement('h4');
    listTitle.textContent = t.notes;
    this.list = document.createElement('div');
    this.list.id = 'notes-list';
    el.append(this.head, compose, listTitle, this.list);
    this.markLayer = document.createElementNS(SVG, 'g');
    this.aiLayer = document.createElementNS(SVG, 'g');
    viewer.overlay.append(this.aiLayer, this.markLayer);

    this.text.addEventListener('input', () => this.refreshSend());
    this.colorInput.addEventListener('input', () => this.setColor(this.colorInput.value));
    this.eyedropBtn.addEventListener('click', () => { this.eyedrop = !this.eyedrop; this.eyedropBtn.classList.toggle('on', this.eyedrop); this.eyedropBtn.title = t.eyedropHint; });
    this.clearColorBtn.addEventListener('click', () => this.setColor(null));
    this.sendBtn.addEventListener('click', () => void this.send());
    viewer.viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') { this.clearMark(); this.timeline.setRange(null); } });
    this.refreshSend();
  }

  private setColor(c: string | null): void {
    this.color = c;
    if (c) this.colorInput.value = c;
    this.clearColorBtn.hidden = !c;
  }

  private refreshSend(): void {
    this.sendBtn.disabled = !this.text.value.trim() && !this.shape.length;
  }

  /** Called after a new version arrives: go to the note that asks to be compared. */
  focusFixed(): void {
    const n = [...this.notes].reverse().find((x) => x.status === 'fixed');
    if (n) this.select(n);
  }

  private drawMark(): void {
    this.markLayer.replaceChildren();
    if (this.shape.length) this.markLayer.append(shapeElement(this.shape, MARK_COLOR));
  }

  private clearMark(): void {
    this.shape = [];
    this.drawMark();
    this.refreshSend();
  }

  private sampleColor(p: Pt): string {
    const c = this.viewer.canvas;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    const sx = Math.max(0, Math.min(c.width - 9, Math.round(p[0] * c.width) - 4));
    const sy = Math.max(0, Math.min(c.height - 9, Math.round(p[1] * c.height) - 4));
    const d = x.getImageData(sx, sy, 9, 9).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
    return `#${sum.map((v) => Math.round(v / (d.length / 4)).toString(16).padStart(2, '0')).join('')}`;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    void this.viewer.pause();
    const vp = this.viewer.viewport;
    if (this.eyedrop) {
      const p = this.viewer.toNorm(e.clientX, e.clientY);
      void this.viewer.pause().then(() => {
        this.setColor(this.sampleColor(p));
        this.eyedrop = false;
        this.eyedropBtn.classList.remove('on');
        this.refreshSend();
      });
      return;
    }
    vp.setPointerCapture(e.pointerId);
    const points: Pt[] = [this.viewer.toNorm(e.clientX, e.clientY)];
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - startX, m.clientY - startY) < CLICK_PX) return;
      moved = true;
      points.push(this.viewer.toNorm(m.clientX, m.clientY));
      this.shape = points;
      this.drawMark();
    };
    const up = () => {
      vp.removeEventListener('pointermove', move);
      vp.removeEventListener('pointerup', up);
      vp.removeEventListener('pointercancel', up);
      const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
      this.shape = points.map(([x, y]) => [clamp(x), clamp(y)]);
      this.anchorFrame = this.viewer.target;
      this.drawMark();
      this.refreshSend();
      this.renderList();
    };
    vp.addEventListener('pointermove', move);
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
  }

  private async send(): Promise<void> {
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = t.sending;
    this.errorEl.hidden = true;
    try {
      await this.viewer.pause();
      const current = this.viewer.target;
      const anchorFrame = this.shape.length ? this.anchorFrame : current;
      const frames = this.timeline.range ?? [anchorFrame, anchorFrame];
      const snapshots = await renderSnapshots(this.viewer, frames, anchorFrame, this.shape);
      await post('/api/notes', { frames, anchor: { frame: anchorFrame, shape: this.shape }, text: this.text.value.trim(), color: this.color, snapshots });
      this.text.value = '';
      this.setColor(null);
      this.clearMark();
      this.timeline.setRange(null);
    } catch (e) {
      this.errorEl.textContent = (e as Error).message;
      this.errorEl.hidden = false;
    } finally {
      this.sendBtn.textContent = t.send;
      this.refreshSend();
    }
  }

  render(state: StreamState): void {
    const { review, waiting } = state;
    this.head.className = 'hint';
    this.head.textContent = waiting ? t.aiWaiting : t.aiNotWaiting;
    this.latest = review.versions.at(-1)?.id ?? '';
    this.notes = review.notes;
    this.timeline.setNotes(this.notes);
    for (const n of this.notes) {
      const key = n.proposal ? `${n.id}:${JSON.stringify(n.proposal)}` : '';
      if (n.status === 'proposed' && !this.seenProposals.has(key)) {
        this.seenProposals.add(key);
        // Someone mid-note keeps their mark and their frame; the card waits in the list.
        if (!this.shape.length && !this.text.value.trim()) this.select(n);
      }
    }
    const sel = this.notes.find((n) => n.id === this.selected);
    this.showProposal(sel?.status === 'proposed' ? sel : null);
    this.renderList();
  }

  private renderList(): void {
    if (!this.notes.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = t.noNotes;
      this.list.replaceChildren(p);
      return;
    }
    const focused = document.activeElement as HTMLInputElement | null;
    const refocus = focused?.classList?.contains('reason') ? { id: focused.dataset.note, at: focused.selectionStart } : null;
    this.list.replaceChildren(...[...this.notes].reverse().map((n) => this.noteCard(n)));
    if (refocus) {
      const input = this.list.querySelector<HTMLInputElement>(`input.reason[data-note="${refocus.id}"]`);
      if (input) { input.focus(); input.setSelectionRange(refocus.at, refocus.at); }
    }
  }

  private showProposal(n: Note | null): void {
    this.aiLayer.replaceChildren();
    this.timeline.setAiRange(n?.proposal?.frames ?? null);
    const region = n?.proposal?.region;
    if (!region?.length) return;
    if (region.length === 1) { this.aiLayer.append(shapeElement(region, '#4fc3f7')); return; }
    const p = document.createElementNS(SVG, 'polygon');
    p.setAttribute('class', 'ai-region');
    p.setAttribute('points', region.map(([x, y]) => `${x},${y}`).join(' '));
    p.setAttribute('fill', 'rgba(79,195,247,.08)');
    p.setAttribute('stroke', '#4fc3f7');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-dasharray', '6 4');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    this.aiLayer.append(p);
  }

  private async answer(n: Note, answer: 'yes' | 'no' | 'not_yet' | 'resolved'): Promise<void> {
    const reason = this.drafts.get(n.id)?.trim() || undefined;
    const body: Record<string, unknown> = { answer, reason };
    this.errorEl.hidden = true;
    try {
      if (answer === 'no' && (this.shape.length || this.timeline.range)) {
        await this.viewer.pause();
        const frames = this.timeline.range ?? n.frames;
        const anchor = this.shape.length ? { frame: this.anchorFrame, shape: this.shape } : n.anchor;
        body.edit = { frames, anchor, snapshots: await renderSnapshots(this.viewer, frames, anchor.frame, anchor.shape) };
      }
      await post(`/api/notes/${encodeURIComponent(n.id)}/answer`, body);
      this.drafts.delete(n.id);
      if (body.edit) { this.clearMark(); this.timeline.setRange(null); }
    } catch (e) {
      this.errorEl.textContent = (e as Error).message;
      this.errorEl.hidden = false;
    }
  }

  private noteCard(n: Note): HTMLElement {
    const card = document.createElement('div');
    card.className = 'note';
    card.dataset.note = n.id;
    card.classList.toggle('ai', n.status === 'proposed');
    card.classList.toggle('selected', n.id === this.selected);
    card.classList.toggle('resolved', n.status === 'resolved');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const where = document.createElement('span');
    where.textContent = t.frames(n.frames[0], n.frames[1]);
    if (n.color) {
      const s = document.createElement('span');
      s.className = 'swatch';
      s.style.background = n.color;
      where.append(' ', s);
    }
    const state = document.createElement('span');
    state.textContent = t.status[n.status];
    meta.append(where, state);
    const body = document.createElement('div');
    body.textContent = n.text;
    card.append(meta, body);
    if (n.version !== this.latest && n.status !== 'resolved') {
      const old = document.createElement('div');
      old.className = 'hint';
      old.textContent = t.oldVersion;
      card.append(old);
    }
    const ask = (buttons: [string, string, 'yes' | 'no' | 'not_yet' | 'resolved', boolean][]) => {
      const reason = document.createElement('input');
      reason.className = 'reason';
      reason.dataset.note = n.id;
      reason.placeholder = t.askReason;
      reason.setAttribute('aria-label', t.askReason);
      reason.value = this.drafts.get(n.id) ?? '';
      reason.addEventListener('input', () => this.drafts.set(n.id, reason.value));
      reason.addEventListener('click', (e) => e.stopPropagation());
      const row = document.createElement('div');
      row.className = 'buttons';
      for (const [label, cls, answer, primary] of buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = primary ? `${cls} primary` : cls;
        b.textContent = label;
        b.addEventListener('click', (e) => { e.stopPropagation(); void this.answer(n, answer); });
        row.append(b);
      }
      card.append(reason, row);
    };
    if (n.status === 'proposed' && n.proposal) {
      const ai = document.createElement('div');
      ai.textContent = n.proposal.text;
      const where2 = document.createElement('div');
      where2.className = 'hint';
      where2.textContent = `AI：${t.frames(n.proposal.frames[0], n.proposal.frames[1])}。${t.noHint}`;
      card.append(ai, where2);
      ask([[t.yes, 'yes', 'yes', true], [t.no, 'no', 'no', false]]);
    }
    if (n.status === 'fixed') ask([[t.resolved, 'resolved', 'resolved', true], [t.notYet, 'not-yet', 'not_yet', false]]);
    card.addEventListener('click', () => this.select(n));
    return card;
  }

  private select(n: Note): void {
    this.selected = n.id;
    this.clearMark();
    this.showProposal(n.status === 'proposed' ? n : null);
    if (n.anchor.shape.length) this.markLayer.append(shapeElement(n.anchor.shape, MARK_COLOR));
    const frame = n.proposal?.frames[0] ?? n.anchor.frame;
    void this.viewer.pause().then(() => this.viewer.seek(frame));
    this.renderList();
  }
}
