import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { markAt } from '../src/web/flash.ts';
import { makeBitVideo, openChrome, startApp, type App, type Browser, type Page } from './helpers.ts';
import { execFileSync } from 'node:child_process';

let browser: Browser, clickVideo: string, silentVideo: string;
before(async () => {
  browser = await openChrome();
  clickVideo = await makeBitVideo({ fps: 30, frames: 300, name: 'bits_click.mp4', clicks: { bpm: 120, offset: 0.25 } });
  silentVideo = await makeBitVideo({ fps: 30, frames: 120, name: 'bits_silent.mp4' });
});
after(async () => { await browser?.close(); });

const analyzed = (p: Page) => p.waitForFunction(() => document.getElementById('timing-status')?.dataset.state === 'done', undefined, { timeout: 60000 });

test('markAt is 1 at a mark, fades over the window, and is 0 before the first', () => {
  assert.equal(markAt([1, 2], 1, 0.2), 1);
  assert.ok(Math.abs(markAt([1, 2], 1.1, 0.2) - 0.5) < 1e-9);
  assert.equal(markAt([1, 2], 1.5, 0.2), 0);
  assert.equal(markAt([1, 2], 0.5, 0.2), 0);
  assert.equal(markAt([], 1, 0.2), 0);
});

test('with a click track: tempo found, ring pulses on the beats outside the picture, layers on the timeline', async () => {
  const app = await startApp(browser, clickVideo);
  try {
    const { page, store } = app;
    await analyzed(page);
    await page.waitForFunction(() => Number((document.getElementById('bpm') as HTMLInputElement)?.value) > 0);
    const t = store.review.timing;
    assert.ok(t.bpm !== null && Math.abs(t.bpm - 120) <= 1, `bpm ${t.bpm}`);
    assert.equal(t.source, 'auto');
    assert.ok(Math.abs(t.offset - 0.25) <= 0.015, `offset ${t.offset}: AAC's encoder delay must not be taken off twice`);
    const layers = await page.evaluate(() => { const l = (window as any).gakuya.timeline.layers; return { beats: l.beats?.length, wave: l.wave?.length }; });
    assert.ok(layers.beats >= 18, `beats ${layers.beats}`);
    assert.ok(layers.wave > 100);

    const edges: number[] = await page.evaluate(async () => {
      const g = (window as any).gakuya, el = g.left.frameGlow as HTMLElement, v = g.left.video as HTMLVideoElement;
      await g.left.play();
      const out: number[] = [];
      let last = 0;
      await new Promise<void>((done) => {
        const tick = () => {
          const a = Number(el.dataset.base);
          if (a > last + 0.2 && a > 0.6) out.push(v.currentTime);
          last = a;
          if (v.currentTime > 4) done(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await g.left.pause();
      return out;
    });
    assert.ok(edges.length >= 6, `pulses ${edges}`);
    const frame = 1 / 30;
    for (const e of edges) {
      const off = ((e - 0.25) % 0.5 + 0.5) % 0.5;
      assert.ok(Math.min(off, 0.5 - off) <= frame + 0.03, `pulse at ${e} is ${off} from a beat`);
    }

    // The ring must touch the glow's edge and never the picture, whatever is drawn beneath it.
    // Inset past the viewport's rounded corners, which sit in the glow's padding, not on the picture.
    const box = (await page.locator('#left .viewport').boundingBox())!;
    const clip = { x: box.x + 4, y: box.y + 4, width: box.width - 8, height: box.height - 8 };
    await page.evaluate(() => (window as any).gakuya.flash.update(-1));
    const pictureOff = await page.screenshot({ clip });
    const edgeOff = await page.locator('#left .frame-glow').screenshot();
    await page.evaluate(() => { const f = (window as any).gakuya.flash; f.update(f.base[1]); });
    assert.deepEqual(await page.screenshot({ clip }), pictureOff, 'the picture is untouched');
    assert.notDeepEqual(await page.locator('#left .frame-glow').screenshot(), edgeOff, 'the edge lights up');
    await page.click('#flash-toggle');
    assert.equal(await page.evaluate(() => { const g = (window as any).gakuya; g.flash.update(g.flash.base[1]); return getComputedStyle(g.left.frameGlow).boxShadow; }), 'none');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('manual tempo sticks across reloads and versions; cues replace beats; analysis is cached', async () => {
  const app = await startApp(browser, clickVideo);
  try {
    const { page, store } = app;
    await analyzed(page);
    await page.waitForFunction(() => Number((document.getElementById('bpm') as HTMLInputElement)?.value) > 0);
    await page.fill('#bpm', '100');
    await page.locator('#bpm').blur();
    await page.waitForFunction(() => document.getElementById('timing-status')?.textContent?.includes('手で'));
    assert.deepEqual([store.review.timing.bpm, store.review.timing.source], [100, 'manual']);
    const beats100 = await page.evaluate(() => (window as any).gakuya.flash.base.slice(0, 2));
    assert.ok(Math.abs(beats100[1] - beats100[0] - 0.6) < 1e-6);

    let analysisPosts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/analysis/')) analysisPosts++; });
    await page.reload();
    await analyzed(page);
    assert.equal(analysisPosts, 0, 'reopening uses the cache');
    assert.equal(await page.inputValue('#bpm'), '100');

    await store.setTiming({ cues: [{ time: 1 }, { time: 2.5 }] });
    await page.waitForFunction(() => (window as any).gakuya.flash.base.length === 2);
    assert.deepEqual(await page.evaluate(() => (window as any).gakuya.timeline.layers.cues.length), 2);

    const other = await makeBitVideo({ fps: 30, frames: 301, name: 'bits30b.mp4' });
    const n = await store.createNote({ frames: [1, 2], anchor: { frame: 1, shape: [] }, text: 'x' });
    await store.propose(n.id, { frames: [1, 2], region: [[0.1, 0.1]], text: '?' });
    await store.answer(n.id, { answer: 'yes' });
    await store.done(n.id, other);
    await page.waitForFunction(() => document.getElementById('version-label')?.textContent?.includes('v2'));
    await analyzed(page);
    assert.equal(store.review.timing.bpm, 100, 'a new version keeps the timing');
  } finally { await app.close(); }
});

test('a video with no audio says so and everything else works', async () => {
  const app = await startApp(browser, silentVideo);
  try {
    const { page, store } = app;
    await analyzed(page);
    assert.match(await page.locator('#timing-status').innerText(), /音声がありません/);
    assert.equal(store.review.timing.bpm, null);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /コマ 1 /.test(document.getElementById('frame-no')!.textContent!));
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('in a video that starts late the beats still land on the sound', async () => {
  const late = await makeBitVideo({ fps: 30, frames: 150, name: 'bits_click_late.mp4', clicks: { bpm: 120, offset: 0.25 }, startOffset: 0.3 });
  const audioStart = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', late]).toString());
  assert.ok(audioStart > 0.1, `the test file must really start late: ${audioStart}`);
  const app = await startApp(browser, late);
  try {
    const { page, store } = app;
    await analyzed(page);
    await page.waitForFunction(() => Number((document.getElementById('bpm') as HTMLInputElement)?.value) > 0);
    // The whole file moved by 0.3, so the clicks sound at 0.3 + 0.25.
    const off = (((store.review.timing.offset - 0.55) % 0.5) + 0.5) % 0.5;
    assert.ok(Math.min(off, 0.5 - off) <= 0.015, `offset ${store.review.timing.offset}, clicks from 0.55`);
    const first = await page.evaluate(() => { const g = (window as any).gakuya; return [g.flash.base[0], g.left.source.timeOf(0)]; });
    assert.ok(first[0] >= first[1], 'no beat before the first frame');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
