import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve, extname } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';

const run = promisify(execFile);
export const TMP = resolve('tests/.tmp');
mkdirSync(TMP, { recursive: true });

export interface BitVideoOpts {
  fps: number; frames: number; name: string; dir?: string; audio?: boolean;
  /** Seconds added to every timestamp, so the first frame is not at 0. */
  startOffset?: number;
  /** Uneven frame spacing. */
  vfr?: boolean;
  /** Click track for the audio: beats per minute and first click in seconds. */
  clicks?: { bpm: number; offset: number };
  codec?: 'libx264' | 'prores_ks';
}

/** Each frame shows its own number as 16 black or white columns, least significant bit on the left. */
export async function makeBitVideo(o: BitVideoOpts): Promise<string> {
  const dir = o.dir ?? TMP;
  mkdirSync(dir, { recursive: true });
  const out = join(dir, o.name);
  if (existsSync(out)) return out;
  const dur = o.frames / o.fps;
  const bits = "format=gray,geq=lum='255*mod(floor(N/pow(2,floor(X/(W/16)))),2)'";
  const vf = o.vfr ? `${bits},setpts='N/${o.fps}/TB+0.02*mod(N,3)/TB'` : bits;
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=black:s=640x360:r=${o.fps}`];
  if (o.clicks) {
    const beat = 60 / o.clicks.bpm;
    const expr = `if(gte(t,${o.clicks.offset})*lt(mod(t-${o.clicks.offset},${beat}),0.01),sin(2*PI*2000*t),0)`;
    args.push('-f', 'lavfi', '-i', `aevalsrc='${expr}':s=48000:d=${dur}`);
  } else if (o.audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`);
  }
  args.push('-frames:v', String(o.frames), '-vf', vf);
  if (o.codec === 'prores_ks') args.push('-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le');
  else args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '2');
  if (o.vfr) args.push('-fps_mode', 'vfr');
  if (o.audio || o.clicks) args.push('-c:a', 'aac', '-shortest');
  if (o.startOffset) args.push('-output_ts_offset', String(o.startOffset));
  args.push(out);
  await run('ffmpeg', args);
  return out;
}

export function openChrome(): Promise<Browser> {
  return chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
}

/** A page that tolerates the __name helper tsx injects into functions passed to evaluate. */
export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript('window.__name = (f) => f');
  return page;
}

/** Bundles a browser test entry into an IIFE. */
export async function bundleForBrowser(entry: string, globalName: string): Promise<string> {
  const r = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName, target: 'es2022' });
  return r.outputFiles[0].text;
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.js': 'text/javascript', '.html': 'text/html' };

/** Minimal Range-aware file server for page-level tests that do not need the real app server. */
export function serveFiles(routes: Record<string, string>): Promise<{ url: string; close(): void }> {
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><canvas id=c></canvas>'); return; }
    const file = routes[path];
    if (!file) { res.statusCode = 404; res.end(); return; }
    const size = statSync(file).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    res.setHeader('accept-ranges', 'bytes'); res.setHeader('content-type', type);
    if (m) {
      const start = Number(m[1] || 0), end = Math.min(Number(m[2] || size - 1), size - 1);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
      res.setHeader('content-length', end - start + 1);
      createReadStream(file, { start, end }).pipe(res);
    } else { res.setHeader('content-length', size); createReadStream(file).pipe(res); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    ok({ url: `http://127.0.0.1:${a.port}`, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

/** Runs in the page: reads the frame number from a canvas showing a bit video. */
export const READ_BITS = `(ctx) => { const w = ctx.canvas.width, h = ctx.canvas.height; let n = 0;
  for (let b = 0; b < 16; b++) { const d = ctx.getImageData(Math.floor((b + .5) * w / 16), h >> 1, 1, 1).data; if (d[0] > 127) n |= 1 << b; }
  return n; }`;

export type { Page, Browser };
export { writeFileSync };

// --- the real app, driven in a real browser ---

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Answer, GakuyaEvent, NewNote, Note, Proposal, Reference, Review, Timing } from '../src/shared/types.ts';

/** The binary under test. `npm test` builds it first; run `npm run build` before running one test file by hand. */
export const BIN = resolve('dist/gakuya');

/** A running gakuya process seen from outside: reads go to review.json, writes go through its API. */
export class Running {
  constructor(readonly dir: string, readonly port: number, readonly token: string, private child: ChildProcess) {}

  get review(): Review { return JSON.parse(readFileSync(join(this.dir, 'review.json'), 'utf8')); }

  note(id: string): Note {
    const n = this.review.notes.find((x) => x.id === id);
    if (!n) throw new Error(`no note ${id}`);
    return n;
  }

  nextEvent(): GakuyaEvent | null { return this.review.events[0] ?? null; }

  /** POST to the API. A refusal throws, as the store did. */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}` }, body: JSON.stringify(body) });
    const value = await r.json() as any;
    if (r.status !== 200) throw new Error(`${path} ${r.status}: ${value?.error}`);
    return value;
  }

  createNote(input: NewNote): Promise<Note> { return this.post('/api/notes', input); }
  propose(id: string, p: Proposal): Promise<Note> { return this.post(`/api/notes/${id}/propose`, p); }
  answer(id: string, a: Answer): Promise<Note> { return this.post(`/api/notes/${id}/answer`, a); }
  /** Hands in a re-rendered video, as `gakuya done` does. */
  done(id: string, video: string): Promise<Note> { return this.post(`/api/notes/${id}/done`, { video }); }
  setTiming(t: Partial<Timing>): Promise<Timing> { return this.post('/api/timing', t); }
  setReference(r: Reference | null): Promise<Reference | null> { return this.post('/api/reference', r); }

  /** Takes the oldest event, as `gakuya wait` does. */
  async wait(): Promise<any> {
    return (await fetch(`http://127.0.0.1:${this.port}/api/wait`, { headers: { authorization: `Bearer ${this.token}` } })).json();
  }

  /** The number of agents waiting, as the page sees it on the stream. */
  async waiting(): Promise<number> {
    const stop = new AbortController();
    const r = await fetch(`http://127.0.0.1:${this.port}/api/stream`, { headers: { authorization: `Bearer ${this.token}` }, signal: stop.signal });
    const { value } = await r.body!.getReader().read();
    stop.abort();
    return JSON.parse(/data: (.*)\n/.exec(Buffer.from(value!).toString())![1]).waiting;
  }

  close(): Promise<void> {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise((ok) => { this.child.once('exit', () => ok()); this.child.kill('SIGTERM'); });
  }
}

/** Starts the binary on `video` in `root` and waits until it has written server.json. */
export async function startGakuya(video: string, root = mkdtempSync(join(tmpdir(), 'gakuya-app-'))): Promise<Running> {
  const child = spawn(BIN, [video, '--review', 'r', '--no-open'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  // A test that fails before it can close this must not keep the test process alive forever.
  child.unref();
  for (const pipe of [child.stdout, child.stderr]) (pipe as unknown as { unref(): void }).unref();
  process.once('exit', () => child.kill('SIGTERM'));
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += d; });
  const dir = join(root, '.gakuya', 'r'), file = join(dir, 'server.json');
  for (let i = 0; i < 500 && !existsSync(file); i++) {
    if (child.exitCode !== null) throw new Error(`gakuya exited ${child.exitCode}: ${stderr}`);
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const { port, token } = JSON.parse(readFileSync(file, 'utf8'));
  return new Running(dir, port, token, child);
}

export interface App { page: Page; store: Running; srv: Running; root: string; errors: string[]; close(): Promise<void> }

export async function startApp(browser: Browser, video: string, opts: { waitForFrame?: boolean; viewport?: { width: number; height: number } } = {}): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'gakuya-app-'));
  const srv = await startGakuya(video, root);
  const store = srv;
  const page = await newPage(browser);
  await page.setViewportSize(opts.viewport ?? { width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.port}/?key=${srv.token}`);
  if (opts.waitForFrame !== false) await page.waitForFunction(() => /コマ 0 /.test(document.getElementById('frame-no')?.textContent ?? ''));
  return { page, store, srv, root, errors, close: async () => { await page.close(); await srv.close(); } };
}

/** The frame number shown as pixels on the paused picture, and the one shown as text. */
export function shown(page: Page, pane = 'left'): Promise<{ bits: number; label: number }> {
  return page.evaluate(({ read, pane }) => {
    const c = document.querySelector(`#${pane} canvas.picture`) as HTMLCanvasElement;
    const bits = eval(read)(c.getContext('2d', { willReadFrequently: true }));
    const label = Number(/コマ (\d+)/.exec(document.getElementById('frame-no')!.textContent ?? '')?.[1]);
    return { bits, label };
  }, { read: READ_BITS, pane });
}

export const settled = (page: Page, frame: number) =>
  page.waitForFunction((f) => new RegExp(`コマ ${f} `).test(document.getElementById('frame-no')?.textContent ?? ''), frame);
