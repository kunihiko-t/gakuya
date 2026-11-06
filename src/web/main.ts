import type { Reference, StreamState, VideoVersion } from '../shared/types.ts';
import { post, stream } from './api.ts';
import { Compare } from './compare.ts';
import { NotesPanel } from './notes.ts';
import { t } from './strings.ts';
import { TimingPanel } from './timing.ts';
import { Timeline } from './timeline.ts';
import { Viewer } from './viewer.ts';

const $ = (id: string) => document.getElementById(id)!;
const left = new Viewer($('left'));
const rightEl = $('right');
const leftLabel = document.createElement('div');
leftLabel.className = 'pane-label';
const rightLabel = document.createElement('div');
rightLabel.className = 'pane-label';
$('left').prepend(leftLabel);
rightEl.append(rightLabel);
const right = new Viewer(rightEl);
const compare = new Compare(left, right);
const timeline = new Timeline($('timeline'), 1);
const panel = new NotesPanel($('side'), left, timeline);
const timing = new TimingPanel(left, timeline);
const playButton = $('play') as HTMLButtonElement;
const comparePick = $('compare-pick') as HTMLSelectElement;
let state: StreamState | null = null;
let current: VideoVersion | null = null;
let mode: 'none' | 'prev' | 'reference' = 'none';
let rightName = '';

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

function showFrame(f: number): void {
  const src = left.source;
  if (src) $('frame-no').textContent = t.frame(f, src.frames, clock(src.timeOf(f) - src.timeOf(0)));
}

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** Goes to a frame and keeps playing if it was, unless a range is being selected. */
async function jumpTo(f: number): Promise<void> {
  const resume = left.playing && !timeline.range;
  await left.pause();
  await left.seek(f);
  if (resume) await left.play();
}

const togglePlay = () => { void (left.playing ? left.pause() : left.play()); };

const fit = () => left.setZoom({ scale: 1, x: 0, y: 0 });
const fitButton = $('fit') as HTMLButtonElement;
fitButton.addEventListener('click', () => { fit(); fitButton.blur(); });
for (const v of [left, right]) v.onZoom((z) => { fitButton.disabled = z.scale === 1; });

window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.key === '0') fit();
  if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    void left.step(e.code === 'ArrowRight' ? 1 : -1);
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) { left.panKey = right.panKey = true; left.panned = right.panned = false; }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || !left.panKey) return;
  left.panKey = right.panKey = false;
  if (!left.panned && !right.panned && !typing(e)) togglePlay();
});

playButton.textContent = t.play;
playButton.addEventListener('click', () => { togglePlay(); playButton.blur(); });
left.onPlay((playing) => { playButton.textContent = playing ? t.pause : t.play; });
left.onFrame(showFrame);
left.onFrame((f) => timeline.setFrame(f));
timeline.onSeek((f) => { void jumpTo(f); });
let resumeAfterScrub = false;
timeline.onScrub((down) => {
  if (down) { resumeAfterScrub = left.playing; void left.pause(); }
  else if (resumeAfterScrub) void left.play();
});
compare.onRightFrame((f) => {
  rightEl.dataset.frame = f === null ? '' : String(f);
  rightLabel.textContent = f === null ? rightName : t.rightFrame(rightName, f);
});

$('compare-label').textContent = t.compare;

function previousVersion(): VideoVersion | null {
  const list = state?.review.versions ?? [];
  const i = list.findIndex((v) => v.id === current?.id);
  return i > 0 ? list[i - 1] : null;
}

function refreshPick(): void {
  const prev = previousVersion();
  const options: [string, string, boolean][] = [['none', t.compareNone, true], ['prev', t.comparePrev, !!prev], ['reference', t.compareRef, true]];
  comparePick.replaceChildren(...options.map(([value, label, enabled]) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.disabled = !enabled;
    return o;
  }));
  comparePick.value = mode;
}

let referenceLoads = 0;

async function showReference(ref: Reference): Promise<void> {
  rightEl.hidden = false;
  rightName = t.compareRef;
  rightLabel.textContent = rightName;
  // The URL stays the same when the path changes, so make each load its own.
  const url = `/media/reference?n=${++referenceLoads}`;
  if (await compare.setRight(url, ref.offsetSeconds)) return;
  if (!(await fetch(url, { method: 'HEAD' })).ok) right.showMessage(t.referenceMissing);
}

async function applyMode(): Promise<void> {
  const prev = previousVersion();
  $('reference-bar').hidden = mode !== 'reference';
  const ref = state?.review.reference;
  if (mode === 'reference' && ref) {
    await showReference(ref);
  } else if (mode === 'prev' && prev) {
    rightEl.hidden = false;
    rightName = t.prevVersion(prev.id);
    rightLabel.textContent = rightName;
    await compare.setRight(`/media/version/${encodeURIComponent(prev.id)}`);
  } else {
    rightEl.hidden = true;
    await compare.setRight(null);
  }
  refreshPick();
}

comparePick.addEventListener('change', () => { mode = comparePick.value as typeof mode; void applyMode(); comparePick.blur(); });

const refPath = $('ref-path') as HTMLInputElement;
const refOffset = $('ref-offset') as HTMLInputElement;
const refError = $('ref-error');
let referenceShown: Reference | null = null;

function saveReference(body: Partial<Reference>): void {
  refError.textContent = '';
  post('/api/reference', body).catch((e: Error) => { refError.textContent = e.message; });
}
refPath.addEventListener('change', () => { if (refPath.value.trim()) saveReference({ path: refPath.value.trim() }); refPath.blur(); });
refOffset.addEventListener('change', () => { saveReference({ offsetSeconds: Number(refOffset.value) || 0 }); refOffset.blur(); });

function onReference(ref: Reference | null): void {
  const was = referenceShown;
  referenceShown = ref;
  if (document.activeElement !== refPath) refPath.value = ref?.path ?? '';
  if (document.activeElement !== refOffset) refOffset.value = String(ref?.offsetSeconds ?? 0);
  if (!current || mode !== 'reference' || !ref) return;
  if (ref.path !== was?.path) void applyMode();
  else if (ref.offsetSeconds !== was?.offsetSeconds) void compare.setOffset(ref.offsetSeconds);
}

async function openVersion(v: VideoVersion, hadVersion: boolean): Promise<void> {
  current = v;
  $('version-label').textContent = t.version(v.id);
  leftLabel.textContent = t.thisVersion(v.id);
  timeline.frames = v.frames;
  await left.open(`/media/version/${encodeURIComponent(v.id)}`);
  void timing.open(v.id);
  if (hadVersion) mode = 'prev';
  await applyMode();
  if (hadVersion) panel.focusFixed();
}

function onState(s: StreamState): void {
  state = s;
  $('review-name').textContent = s.review.name;
  const latest = s.review.versions.at(-1) ?? null;
  const changed = latest && latest.id !== current?.id;
  const hadVersion = !!current;
  if (!current && s.review.reference) mode = 'reference';
  panel.render(s);
  onReference(s.review.reference);
  timing.render(s.review.timing);
  if (changed) void openVersion(latest, hadVersion);
  else refreshPick();
}

stream(onState, () => left.showMessage(t.connectionLost));
Object.assign(window, { gakuya: { left, right, timeline, compare, flash: timing.flash } });
