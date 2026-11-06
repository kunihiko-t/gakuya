import type { Timing } from '../shared/types.ts';
import { analyzeAudio, beatTimes, findOnsets, motionFromGray } from './analysis.ts';
import { getJson, post } from './api.ts';
import { Flash } from './flash.ts';
import { FrameSource } from './frames.ts';
import { t } from './strings.ts';
import type { Timeline } from './timeline.ts';
import type { Viewer } from './viewer.ts';

/** What one version's analysis found. Saved beside the review so reopening does not repeat it. */
interface Analysis { audio: 'ok' | 'none' | 'unreadable'; bpm: number | null; offset: number; wave: number[]; motion: number[]; onsets: number[] }

const SMALL = 64;
const AUDIO_RATE = 44100;

async function readAudio(url: string, source: FrameSource): Promise<Pick<Analysis, 'audio' | 'bpm' | 'offset' | 'wave'>> {
  const none = { bpm: null, offset: 0, wave: [] };
  const audioStart = await source.audioStart();
  if (audioStart === null) return { audio: 'none', ...none };
  let buffer: AudioBuffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, AUDIO_RATE).decodeAudioData(await (await fetch(url)).arrayBuffer());
  } catch {
    return { audio: 'unreadable', ...none };
  }
  // Exactly the video's span, on the video's clock, so the waveform lines up with the timeline. decodeAudioData drops
  // the track's start time, so put it back here.
  const start = source.timeOf(0);
  const samples = new Float32Array(Math.ceil((source.timeOf(source.frames - 1) + 1 / source.fps - start) * AUDIO_RATE));
  // A negative start is the encoder's delay, which decoding has already removed.
  const shift = Math.round((Math.max(0, audioStart) - start) * AUDIO_RATE);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = Math.max(0, shift); i < samples.length && i - shift < data.length; i++) samples[i] += data[i - shift] / buffer.numberOfChannels;
  }
  const { bpm, offset, wave } = analyzeAudio(samples, AUDIO_RATE);
  return { audio: 'ok', bpm, offset: offset + start, wave: Array.from(wave, (v) => +v.toFixed(3)) };
}

async function analyze(url: string, onProgress: (done: number) => void): Promise<Analysis> {
  const source = await FrameSource.open(url);
  try {
    const audio = await readAudio(url, source);
    const scale = SMALL / Math.max(source.width, source.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const gray: Uint8Array[] = [];
    for await (const i of source.scan(ctx)) {
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const g = new Uint8Array(canvas.width * canvas.height);
      for (let p = 0; p < g.length; p++) g[p] = (data[p * 4] + data[p * 4 + 1] * 2 + data[p * 4 + 2]) >> 2;
      gray.push(g);
      if (i % 10 === 0) onProgress(i / source.frames);
    }
    const motion = motionFromGray(gray);
    return { ...audio, motion: Array.from(motion, (v) => +v.toFixed(4)), onsets: findOnsets(motion, source.fps).onsets };
  } finally {
    source.close();
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Tempo inputs, the ring, and the timeline layers for the left picture. */
export class TimingPanel {
  readonly flash: Flash;
  private timing: Timing | null = null;
  private analysis: Analysis | null = null;
  private run = 0;
  private failed = false;
  private bpm = $<HTMLInputElement>('bpm');
  private offset = $<HTMLInputElement>('offset');
  private status = $('timing-status');

  constructor(private viewer: Viewer, private timeline: Timeline) {
    this.flash = new Flash(viewer.frameGlow);
    const save = () => {
      const bpm = this.bpm.value === '' ? null : Number(this.bpm.value);
      void post('/api/timing', { bpm: bpm !== null && bpm > 0 ? bpm : null, offset: Number(this.offset.value) || 0, source: 'manual' });
    };
    this.bpm.addEventListener('change', save);
    this.offset.addEventListener('change', save);
    const toggle = $<HTMLInputElement>('flash-toggle');
    toggle.addEventListener('change', () => {
      this.flash.enabled = toggle.checked;
      this.flash.update(viewer.source?.timeOf(viewer.frame) ?? 0);
      toggle.blur();
    });
    viewer.onFrame((f) => { if (!viewer.playing && viewer.source) this.flash.update(viewer.source.timeOf(f)); });
    const tick = () => {
      if (!viewer.playing) return;
      this.flash.update(viewer.video.currentTime);
      requestAnimationFrame(tick);
    };
    viewer.onPlay((playing) => { if (playing) requestAnimationFrame(tick); });
  }

  render(timing: Timing): void {
    this.timing = timing;
    if (document.activeElement !== this.bpm) this.bpm.value = timing.bpm === null ? '' : String(timing.bpm);
    if (document.activeElement !== this.offset) this.offset.value = String(Math.round(timing.offset * 1000) / 1000);
    this.apply();
  }

  /** Call after the viewer has opened this version. Everything else keeps working while this runs. */
  async open(versionId: string): Promise<void> {
    const run = ++this.run;
    const id = encodeURIComponent(versionId);
    this.analysis = null;
    this.failed = false;
    this.apply();
    try {
      let found = await getJson<Analysis>(`/api/analysis/${id}`);
      if (!found) {
        found = await analyze(`/media/version/${id}`, (done) => {
          if (run === this.run) this.setStatus('working', t.analyzing(Math.round(done * 100)));
        });
        await post(`/api/analysis/${id}`, found);
      }
      if (run !== this.run) return;
      this.analysis = found;
      if (this.timing?.source === 'auto' && this.timing.bpm === null && found.bpm !== null) {
        await post('/api/timing', { bpm: found.bpm, offset: found.offset, source: 'auto' });
      }
    } catch {
      if (run === this.run) this.failed = true;
    }
    if (run === this.run) this.apply();
  }

  private setStatus(state: 'working' | 'done', text: string): void {
    this.status.dataset.state = state;
    this.status.textContent = text;
  }

  private statusText(a: Analysis, timing: Timing): string {
    const parts: string[] = [];
    if (a.audio === 'none') parts.push(t.noAudio);
    if (a.audio === 'unreadable') parts.push(t.audioUnreadable);
    if (timing.cues.length) parts.push(t.usingCues(timing.cues.length));
    else if (timing.source === 'manual') parts.push(t.tempoManual);
    else if (timing.source === 'agent') parts.push(t.tempoAgent);
    else if (a.audio === 'ok') parts.push(timing.bpm === null ? t.tempoNotFound : t.tempoAuto);
    return parts.join(' ／ ');
  }

  private apply(): void {
    const src = this.viewer.source, timing = this.timing, a = this.analysis;
    if (!src || !timing) return;
    if (this.failed) this.setStatus('done', t.analysisFailed);
    else if (a) this.setStatus('done', this.statusText(a, timing));
    else this.setStatus('working', t.analyzing(0));

    const end = src.timeOf(src.frames - 1) + 1 / (src.fps || 30);
    const beats = timing.bpm === null ? [] : beatTimes(timing.bpm, timing.offset, end).filter((b) => b >= src.timeOf(0));
    const cues = timing.cues.map((c) => c.time).sort((x, y) => x - y);
    const onsets = (a?.onsets ?? []).map((f) => src.timeOf(f));
    this.flash.setMarks(cues.length ? cues : beats, onsets);

    const toFrames = (times: number[]) => times.map((s) => src.frameAt(s));
    // Cuts are spikes far above the dancing; scale to the dancing.
    const scale = a?.motion.length ? [...a.motion].sort((x, y) => x - y)[Math.floor(a.motion.length * 0.98)] || 1 : 1;
    this.timeline.setLayers({
      wave: a?.wave.length ? a.wave : undefined,
      beats: beats.length ? toFrames(beats) : undefined,
      cues: cues.length ? toFrames(cues) : undefined,
      motion: a?.motion.map((v) => v / scale),
      onsets: a ? a.onsets : undefined,
    });
  }
}
