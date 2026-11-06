import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN, TMP, makeBitVideo, newPage, openChrome, startGakuya, type Browser, type Page, type Running } from './helpers.ts';

const INFO = { fps: 30, frames: 300, width: 640, height: 360 };
const knobs = [
  { id: 'gloss', label: '服の光沢', min: 0, max: 3, default: 1, scale: 'linear', scope: 'global' },
  { id: 'hue', label: '光の色', min: 0, max: 360, default: null, scale: 'linear', scope: 'range', reset: '場面どおりに戻す' },
];

/** The renderer contract in docs/live-renderer.md, drawing a solid color: red when gloss is above 1, blue otherwise. */
class FakeRenderer {
  url = '';
  got: any[] = [];
  gotHeaders: Record<string, any>[] = [];
  reloads = 0;
  frozen = false;
  /** Holds one old picture from before the page arrived, as a renderer that has been running does. */
  stale = false;
  private id = 0;
  private server!: Server;
  private jpegs!: { red: Buffer; blue: Buffer };

  async start(info = INFO): Promise<this> {
    const jpeg = (color: string) => execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=${color}:s=640x360`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
    this.jpegs = { red: jpeg('red'), blue: jpeg('blue') };
    this.server = createServer((req, res) => {
      if (this.frozen) { res.destroy(); return; }
      const url = new URL(req.url!, 'http://x');
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        this.gotHeaders.push(req.headers);
        if (url.pathname === '/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...info, knobs: ['gloss', 'hue'] })); return; }
        if (url.pathname === '/knobs') {
          this.got.push(JSON.parse(Buffer.concat(chunks).toString()));
          this.id++;
          res.setHeader('content-type', 'application/json'); res.end('{}');
          return;
        }
        if (url.pathname === '/reload') { this.reloads++; res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
        if (url.pathname === '/frame') {
          const last = this.got.at(-1);
          if (this.stale) {
            this.stale = false;
            res.setHeader('content-type', 'image/jpeg');
            res.setHeader('x-frame-id', '0');
            res.setHeader('x-song-frame', '250');
            res.setHeader('x-knob-seq', '1');
            res.end(this.jpegs.red);
            return;
          }
          if (Number(url.searchParams.get('after')) >= this.id) { res.statusCode = 204; setTimeout(() => res.end(), 30); return; }
          res.setHeader('content-type', 'image/jpeg');
          res.setHeader('x-frame-id', String(this.id));
          res.setHeader('x-song-frame', String(last?.seek ?? 0));
          res.setHeader('x-knob-seq', String(last?.seq ?? 0));
          res.end((last?.values?.gloss ?? 1) > 1 ? this.jpegs.red : this.jpegs.blue);
          return;
        }
        res.statusCode = 404; res.end();
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close(): void { this.server.closeAllConnections(); this.server.close(); }
}

let browser: Browser, video: string;
let renderer: FakeRenderer | null = null, srv: Running | null = null, page: Page | null = null;

before(async () => {
  browser = await openChrome();
  video = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30-clicks.mp4', clicks: { bpm: 120, offset: 0.5 } });
});
after(async () => { await page?.close(); await srv?.close(); renderer?.close(); await browser?.close(); });

async function open(info = INFO, stale = false): Promise<{ page: Page; srv: Running; renderer: FakeRenderer }> {
  await page?.close(); await srv?.close(); renderer?.close();
  renderer = await new FakeRenderer().start(info);
  renderer.stale = stale;
  srv = await startGakuya(video, undefined, ['--live', renderer.url]);
  page = await newPage(browser);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${srv.port}/?key=${srv.token}`);
  await page.waitForFunction(() => /コマ 0 /.test(document.getElementById('frame-no')?.textContent ?? ''));
  return { page, srv, renderer };
}

const pixel = (p: Page) => p.evaluate(() => {
  const c = document.querySelector('#left canvas.live') as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
  return d[0] > d[2] ? 'red' : 'blue';
});
const slide = (p: Page, id: string, to: number) => p.locator(`.knob[data-knob="${id}"] input[type=range]`).evaluate((el: HTMLInputElement, v) => {
  el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
}, to);

test('a person without a renderer sees no live controls', async () => {
  const plain = await startGakuya(video);
  const p = await newPage(browser);
  await p.goto(`http://127.0.0.1:${plain.port}/?key=${plain.token}`);
  await p.waitForFunction(() => /コマ 0 /.test(document.getElementById('frame-no')?.textContent ?? ''));
  assert.equal(await p.locator('#live-toggle').isVisible(), false);
  assert.equal(await p.locator('#knobs').isVisible(), false);
  await p.close(); await plain.close();
});

test('--live refuses anything but this machine', () => {
  const r = spawnSync(BIN, [video, '--live', 'http://example.com:9000', '--no-open'], { cwd: mkdtempSync(join(tmpdir(), 'gakuya-live-')), encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /手元/);
});

test('moving a knob changes the picture, and only settling reaches the agent', async () => {
  const { page, srv, renderer } = await open();
  await srv.post('/api/knobs', knobs);
  await page.click('#live-toggle');
  await page.waitForSelector('.knob[data-knob="gloss"]');
  await page.waitForFunction(() => (document.querySelector('#left canvas.live') as HTMLElement | null)?.dataset.frame !== undefined);
  assert.equal(await pixel(page), 'blue');
  await slide(page, 'gloss', 800);
  await page.waitForFunction(() => {
    const c = document.querySelector('#left canvas.live') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return d[0] > d[2];
  });
  assert.ok(renderer.got.at(-1).values.gloss > 2);
  assert.equal(srv.nextEvent(), null, 'moving a knob tells the agent nothing');

  const got = srv.wait();
  await page.click('#settle');
  const r = await got;
  assert.equal(r.event.type, 'settled');
  assert.ok(Math.abs(r.event.values.gloss - 2.4) < 0.01);
  assert.equal(r.event.values.hue, null, 'an untouched knob says it holds no value');
  assert.equal(r.event.frames, undefined, 'no range was chosen');
  assert.equal(typeof r.event.frame, 'number');
  assert.ok(r.video.endsWith('.mp4'));
  assert.equal(typeof r.timing.offset, 'number', 'the tempo comes along, to turn beats into frames');
  assert.equal(srv.nextEvent(), null, 'delivered once');
});

test('entering live on a stopped video keeps the renderer stopped, at the same frame', async () => {
  const { page, renderer } = await open();
  await page.click('#live-toggle');
  await page.waitForFunction(() => (window as any).gakuya.live.connected);
  assert.equal(renderer.got[0].paused, true);
  assert.equal(renderer.got[0].seek, 0);
});

test('a picture from before going live is never shown', async () => {
  const { page } = await open(INFO, true);
  await page.click('#live-toggle');
  await page.waitForFunction(() => (window as any).gakuya.live.connected);
  assert.equal(await page.evaluate(() => (document.querySelector('#left canvas.live') as HTMLElement).dataset.frame), '0');
  assert.equal(await pixel(page), 'blue');
});

test('a note written on the live picture carries that picture, not the old video frame', async () => {
  const { page, srv } = await open();
  await srv.post('/api/knobs', knobs);
  await page.click('#live-toggle');
  await page.waitForSelector('.knob[data-knob="gloss"]');
  await slide(page, 'gloss', 800);
  await page.waitForFunction(() => {
    const c = document.querySelector('#left canvas.live') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return d[0] > d[2];
  });
  await page.fill('#note-text', 'この赤が強い');
  const got = srv.wait();
  await page.click('#note-send');
  const r = await got;
  const raw = r.snapshots.find((s: string) => s.endsWith('raw.png'));
  const [red, , blue] = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', raw, '-vf', 'crop=1:1:iw/2:ih/2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(red > 200 && blue < 60, `the center of the snapshot is rgb(${red},_,${blue})`);
});

test('offering the same knobs again puts them back at their defaults', async () => {
  const { page, srv, renderer } = await open();
  await srv.post('/api/knobs', knobs);
  await page.click('#live-toggle');
  await page.waitForSelector('.knob[data-knob="gloss"]');
  await slide(page, 'gloss', 800);
  await page.waitForFunction(() => /2\.40/.test(document.querySelector('.knob[data-knob="gloss"]')!.textContent!));
  await srv.post('/api/knobs', knobs);
  await page.waitForFunction(() => /1\.00/.test(document.querySelector('.knob[data-knob="gloss"]')!.textContent!), undefined, { timeout: 5000 });
  for (let i = 0; i < 50 && renderer.got.at(-1).values.gloss !== 1; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(renderer.got.at(-1).values.gloss, 1);
});

test('the renderer never sees the page key or the agent token', async () => {
  const { page, srv, renderer } = await open();
  await page.click('#live-toggle');
  await page.waitForFunction(() => (window as any).gakuya.live.connected);
  await srv.post('/live/reload', {});
  assert.equal(renderer.reloads, 1, 'the agent can ask for a reload');
  const leaks = renderer.gotHeaders.filter((h) => h.cookie || h.authorization);
  assert.deepEqual(leaks, []);
});

test('only the renderer contract goes through the relay', async () => {
  const { srv } = await open();
  const r = await fetch(`http://127.0.0.1:${srv.port}/live/other`, { headers: { authorization: `Bearer ${srv.token}` } });
  assert.equal(r.status, 404);
});

test('a range reaches the renderer snapped to beats, and range knobs act inside it', async () => {
  const { page, srv, renderer } = await open();
  await srv.post('/api/knobs', knobs);
  await page.waitForFunction(() => (window as any).gakuya.timeline.layers?.beats?.length > 10, undefined, { timeout: 60000 });
  await page.click('#live-toggle');
  await page.waitForSelector('.knob[data-knob="hue"]');
  const box = (await page.locator('#timeline canvas').boundingBox())!;
  const x = (f: number) => box.x + box.width * f / 299;
  await page.mouse.move(x(52), box.y + 20);
  await page.mouse.down();
  await page.mouse.move(x(83), box.y + 20, { steps: 4 });
  await page.mouse.up();
  const range = await page.evaluate(() => (window as any).gakuya.timeline.range);
  const beats: number[] = await page.evaluate(() => (window as any).gakuya.timeline.layers.beats);
  assert.ok(beats.includes(range[0]) && beats.includes(range[1]), `range ${range} lands on detected beats`);
  assert.ok(Math.abs(range[0] - 60) <= 2 && Math.abs(range[1] - 90) <= 2, `range ${range} is where the clicks are, every 15 frames`);
  const inRange = () => page.evaluate(() => { const g = (window as any).gakuya; return g.left.frame >= g.timeline.range[0] && g.left.frame <= g.timeline.range[1]; });
  await page.waitForFunction(() => { const g = (window as any).gakuya; return g.left.frame === g.timeline.range[0]; }, undefined, { timeout: 5000 });
  assert.ok(await inRange(), 'the playhead moves into the range, or a range knob would seem to do nothing');
  await slide(page, 'hue', 500);
  await page.waitForFunction(() => /180/.test(document.querySelector('.knob[data-knob="hue"]')!.textContent!));
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && renderer.got.at(-1)?.rangeValues?.hue !== 180; i++) await new Promise((ok) => setTimeout(ok, 20));
  const last = renderer.got.at(-1);
  assert.equal(last.rangeValues.hue, 180);
  assert.deepEqual(last.range, range);
  assert.equal(last.values.hue, undefined, 'a range knob is not sent as a whole-song value');
  assert.equal(last.values.gloss, 1);
  const got = srv.wait();
  await page.click('#settle');
  assert.deepEqual((await got).event.frames, range);
});

test('playing from outside a range goes to the range, and repeats it', async () => {
  const { page } = await open();
  await page.waitForFunction(() => (window as any).gakuya.timeline.layers?.beats?.length > 10, undefined, { timeout: 60000 });
  await page.click('#live-toggle');
  await page.evaluate(() => { const g = (window as any).gakuya; g.timeline.setRange([60, 90]); g.left.video.muted = true; });
  await page.evaluate(() => (window as any).gakuya.left.seek(200));
  await page.waitForFunction(() => (window as any).gakuya.left.frame === 200);
  await page.evaluate(() => (window as any).gakuya.left.play());
  const seen: number[] = await page.evaluate(async () => {
    const g = (window as any).gakuya, out: number[] = [];
    for (let i = 0; i < 50; i++) { out.push(g.left.frame); await new Promise((ok) => setTimeout(ok, 50)); }
    g.left.pause();
    return out;
  });
  const later = seen.slice(20);
  assert.ok(later.every((f) => f >= 58 && f <= 95), `stays in the range: ${later}`);
  assert.ok(new Set(later).size > 5, `and moves: ${later}`);
  assert.ok(later.some((f, i) => i > 0 && f < later[i - 1]), `and comes back around: ${later}`);
});

test('leaving live pauses the renderer; a video review range is not snapped', async () => {
  const { page, renderer } = await open();
  await page.waitForFunction(() => (window as any).gakuya.timeline.layers?.beats?.length > 10, undefined, { timeout: 60000 });
  const box = (await page.locator('#timeline canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 52 / 299, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 83 / 299, box.y + 20, { steps: 4 });
  await page.mouse.up();
  const range: number[] = await page.evaluate(() => (window as any).gakuya.timeline.range);
  assert.ok(Math.abs(range[0] - 52) <= 1 && Math.abs(range[1] - 83) <= 1, `rough range kept: ${range}`);
  await page.click('#live-toggle');
  await page.waitForFunction(() => (window as any).gakuya.live.connected);
  await page.click('#live-toggle');
  for (let i = 0; i < 50 && !renderer.got.at(-1)?.paused; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(renderer.got.at(-1).paused, true);
});

test('a stopped renderer is said out loud, and settling is refused until it returns', async () => {
  const { page, renderer } = await open();
  await page.click('#live-toggle');
  await page.waitForFunction(() => (window as any).gakuya.live.connected);
  renderer.frozen = true;
  await page.waitForFunction(() => /描画側が応答していません/.test(document.getElementById('left')!.textContent!), undefined, { timeout: 10000 });
  assert.equal(await page.locator('#settle').isDisabled(), true);
  const before = renderer.got.length;
  renderer.frozen = false;
  await page.waitForFunction(() => !/描画側が応答していません/.test(document.getElementById('left')!.textContent!), undefined, { timeout: 10000 });
  for (let i = 0; i < 100 && renderer.got.length === before; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(renderer.got.length > before, 'a restarted renderer has forgotten the values, so they go again');
  assert.equal(renderer.got.at(-1).seek, 0);
});

test('a renderer with another length is refused on screen', async () => {
  const { page } = await open({ ...INFO, frames: 299 });
  await page.waitForFunction(() => /コマ数/.test((document.getElementById('live-problem') as HTMLElement).textContent!), undefined, { timeout: 10000 });
  assert.equal(await page.locator('#live-toggle').isDisabled(), true);
});

test('bad knob lists and settled values are refused', async () => {
  const { srv } = await open();
  const bad = [
    [{ ...knobs[0], id: '' }],
    [knobs[0], knobs[0]],
    [{ ...knobs[0], min: 1, max: 1 }],
    [{ ...knobs[0], scale: 'log', min: 0 }],
    [{ ...knobs[0], scope: 'everywhere' }],
    [{ ...knobs[0], default: 9 }],
    [{ ...knobs[0], id: 'unknown-to-the-renderer' }],
  ];
  for (let i = 0; i < 100 && !(await srv.post('/api/knobs', [{ ...knobs[0], id: 'probe' }]).then(() => false, () => true)); i++) await new Promise((ok) => setTimeout(ok, 50));
  for (const list of bad) await assert.rejects(srv.post('/api/knobs', list), /400/, JSON.stringify(list));
  await srv.post('/api/knobs', knobs);
  await assert.rejects(srv.post('/api/settled', { values: { nope: 1 }, frames: null, frame: 0 }), /400/);
  await assert.rejects(srv.post('/api/settled', { values: { gloss: 9 }, frames: null, frame: 0 }), /400/);
  await assert.rejects(srv.post('/api/settled', { values: { gloss: 1 }, frames: [5, 999], frame: 0 }), /400/);
  await assert.rejects(srv.post('/api/settled', { values: { gloss: 1 }, frames: null, frame: 999 }), /400/);
});

test('a running review can join a renderer later, and take a render with no note', async () => {
  await page?.close(); page = null; await srv?.close(); srv = null; renderer?.close();
  renderer = await new FakeRenderer().start();
  srv = await startGakuya(video);
  const cwd = join(srv.dir, '..', '..');
  execFileSync(BIN, ['live', renderer.url], { cwd, encoding: 'utf8' });
  assert.equal(spawnSync(BIN, ['live', 'http://example.com'], { cwd, encoding: 'utf8' }).status, 1);
  const longer = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30-clicks-b.mp4', clicks: { bpm: 90, offset: 0.5 } });
  execFileSync(BIN, ['render', '--video', longer], { cwd, encoding: 'utf8' });
  assert.equal(srv.review.versions.length, 2);
  await promisify(execFile)(BIN, ['reload'], { cwd }); // not Sync: the renderer lives in this process and has to answer
  assert.equal(renderer.reloads, 1);
});

test('gakuya knobs loads a file through the CLI, and the page follows', async () => {
  const { page: p, srv } = await open();
  const file = join(TMP, 'knobs.json');
  writeFileSync(file, JSON.stringify(knobs));
  execFileSync(BIN, ['knobs', '--file', file], { cwd: join(srv.dir, '..', '..'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(join(srv.dir, 'review.json'), 'utf8')).knobs.map((k: any) => k.id), ['gloss', 'hue']);
  await p.click('#live-toggle');
  await p.waitForSelector('.knob[data-knob="gloss"]');
});
