import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeBitVideo, openChrome, startApp, shown, settled, TMP, type App, type Browser } from './helpers.ts';

let browser: Browser, app: App;
before(async () => {
  browser = await openChrome();
  app = await startApp(browser, await makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' }));
});
after(async () => { await app?.close(); await browser?.close(); });

test('arrow keys step one frame and the picture matches the label', async () => {
  const { page } = app;
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await settled(page, 5);
  assert.deepEqual(await shown(page), { bits: 5, label: 5 });
  await page.keyboard.press('ArrowLeft');
  await settled(page, 4);
  assert.deepEqual(await shown(page), { bits: 4, label: 4 });
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await settled(page, 0);
  assert.deepEqual(await shown(page), { bits: 0, label: 0 }, 'stops at the first frame');
});

test('stopping playback lands on an exact frame', async () => {
  const { page } = app;
  await page.keyboard.press('Space');
  await page.waitForFunction(() => { const v = document.querySelector('#left video') as HTMLVideoElement; return !v.paused && v.currentTime > 0.3; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#left canvas.picture')?.getAttribute('data-state') === 'still');
  const s = await shown(page);
  assert.equal(s.bits, s.label);
  assert.ok(s.label > 0);
});

test('zooming keeps a point of the picture at the same normalized position', async () => {
  const { page } = app;
  const box = (await page.locator('#left .viewport').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const norm = (x: number, y: number) => page.evaluate(([x, y]) => (window as any).gakuya.left.toNorm(x, y), [x, y]);
  const before = await norm(cx + 40, cy + 30);
  await page.mouse.move(cx + 40, cy + 30);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => (window as any).gakuya.left.zoom.scale > 1);
  const under = await norm(cx + 40, cy + 30);
  assert.ok(Math.abs(under[0] - before[0]) < 0.005 && Math.abs(under[1] - before[1]) < 0.005, 'the point under the cursor stays put');
  const off = await norm(cx + 140, cy + 30);
  assert.ok(off[0] - under[0] < 100 / 500 && off[0] > under[0], 'zoomed in: the same distance covers less of the picture');
  // Space + drag pans
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 30, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const panned = await norm(cx + 90, cy + 30);
  assert.ok(Math.abs(panned[0] - under[0]) < 0.005, 'the picture followed the pointer');
  const v = await page.evaluate(() => (document.querySelector('#left video') as HTMLVideoElement).paused);
  assert.equal(v, true, 'a pan is not a play toggle');
  await page.evaluate(() => (window as any).gakuya.left.setZoom({ scale: 1, x: 0, y: 0 }));
});

test('an undecodable file shows a reason instead of a blank page', async () => {
  const prores = await makeBitVideo({ fps: 30, frames: 10, name: 'prores.mov', codec: 'prores_ks' });
  const a = await startApp(browser, prores, { waitForFrame: false });
  try {
    await a.page.waitForFunction(() => /再生できない形式/.test(document.getElementById('left')?.textContent ?? ''));
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); }
});

test('a path with spaces and Japanese plays', async () => {
  const v = await makeBitVideo({ fps: 30, frames: 60, name: '踊り 最終.mp4', dir: join(TMP, '空白 日本語') });
  const a = await startApp(browser, v);
  try {
    await a.page.keyboard.press('ArrowRight');
    await settled(a.page, 1);
    assert.deepEqual(await shown(a.page), { bits: 1, label: 1 });
  } finally { await a.close(); }
});

test('a video with a start offset still numbers frames in order', async () => {
  const a = await startApp(browser, await makeBitVideo({ fps: 30, frames: 120, name: 'bits_offset.mp4', startOffset: 0.5 }));
  try {
    await a.page.keyboard.press('ArrowRight');
    await settled(a.page, 1);
    assert.deepEqual(await shown(a.page), { bits: 1, label: 1 });
  } finally { await a.close(); }
});

// --- moving through the video, and looking around while it plays ---

const video = () => makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' });
const playing = (page: App['page']) => page.waitForFunction(() => { const v = document.querySelector('#left video') as HTMLVideoElement; return !v.paused && v.currentTime > 0.2; });
const still = (page: App['page']) => page.waitForFunction(() => { const g = (window as any).gakuya; return g.left.canvas.dataset.state === 'still' && !g.left.drawing; });

test('replacing the video while a frame is decoding raises nothing', async () => {
  const a = await startApp(browser, await video());
  try {
    await a.page.evaluate(async () => {
      const v = (window as any).gakuya.left;
      void v.seek(250);
      await v.open(v.video.src);
    });
    await a.page.waitForTimeout(200);
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); }
});

test('the play button starts and stops at any moment', async () => {
  const a = await startApp(browser, await video());
  try {
    await a.page.click('#play');
    await playing(a.page);
    await a.page.click('#play');
    await still(a.page);
    const s = await shown(a.page);
    assert.equal(s.bits, s.label);
    assert.ok(s.label > 0);
  } finally { await a.close(); }
});

test('sliding the seek bar shows frames along the way and lands on an exact one', async () => {
  const a = await startApp(browser, await video());
  try {
    const { page } = a;
    await page.evaluate(() => { const w = window as any; w.seen = []; w.gakuya.left.onFrame((f: number) => w.seen.push(f)); });
    const r = (await page.locator('#seek').boundingBox())!;
    const y = r.y + r.height / 2;
    await page.mouse.move(r.x + r.width * 0.1, y);
    await page.mouse.down();
    for (const u of [0.2, 0.3, 0.4, 0.5]) {
      await page.mouse.move(r.x + r.width * u, y, { steps: 2 });
      await page.waitForTimeout(150);
    }
    await page.mouse.up();
    await still(page);
    const s = await shown(page);
    assert.equal(s.bits, s.label);
    assert.ok(Math.abs(s.label - 150) < 12, `landed on ${s.label}`);
    const seen: number[] = await page.evaluate(() => (window as any).seen);
    assert.ok(new Set(seen).size >= 3, `the picture followed the slide: ${seen}`);
    assert.equal(await page.evaluate(() => (window as any).gakuya.timeline.range), null, 'sliding is not a range');
    assert.equal(Number(await page.inputValue('#seek')), s.label);
    await page.keyboard.press('Space');
    await playing(page);
    await page.keyboard.press('Space');
    await still(page);
  } finally { await a.close(); }
});

test('sliding during playback goes on playing from the new place; so does a timeline click', async () => {
  const a = await startApp(browser, await video());
  try {
    const { page } = a;
    await page.click('#play');
    await playing(page);
    const r = (await page.locator('#seek').boundingBox())!;
    const y = r.y + r.height / 2;
    await page.mouse.move(r.x + r.width * 0.5, y);
    await page.mouse.down();
    await page.waitForFunction(() => (document.querySelector('#left video') as HTMLVideoElement).paused);
    await page.mouse.move(r.x + r.width * 0.7, y, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => { const v = document.querySelector('#left video') as HTMLVideoElement; return !v.paused && v.currentTime > 6.5; });
    const c = (await page.locator('#timeline canvas').boundingBox())!;
    await page.mouse.click(c.x + c.width * 0.2, c.y + c.height / 2);
    await page.waitForFunction(() => { const v = document.querySelector('#left video') as HTMLVideoElement; return !v.paused && v.currentTime > 2 && v.currentTime < 4; });
    assert.equal(await page.evaluate(() => (window as any).gakuya.timeline.range), null);
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); }
});

test('the view can move while playing, and pointing then stops on the frame with the mark in place', async () => {
  const a = await startApp(browser, await video());
  try {
    const { page, store } = a;
    await page.click('#play');
    await playing(page);
    const box = (await page.locator('#left .viewport').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => (window as any).gakuya.left.zoom.scale > 1);
    await page.keyboard.down('Space');
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 20, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    const z = await page.evaluate(() => { const g = (window as any).gakuya; return { paused: g.left.video.paused, ...g.left.zoom }; });
    assert.equal(z.paused, false, 'moving the view does not stop playback');
    const want = await page.evaluate(([x, y]) => (window as any).gakuya.left.toNorm(x, y), [cx + 30, cy - 10]);
    await page.mouse.click(cx + 30, cy - 10);
    await still(page);
    const s = await shown(page);
    assert.equal(s.bits, s.label);
    assert.deepEqual(await page.evaluate(() => { const { scale, x, y } = (window as any).gakuya.left.zoom; return { scale, x, y }; }), { scale: z.scale, x: z.x, y: z.y }, 'stopping keeps the view');
    await page.fill('#note-text', 'ここ');
    const got = page.waitForFunction(() => document.querySelector('#notes-list .note'));
    await page.click('#note-send');
    await got;
    const note = store.review.notes[0];
    assert.equal(note.anchor.frame, s.label);
    assert.ok(Math.abs(note.anchor.shape[0][0] - want[0]) < 0.003 && Math.abs(note.anchor.shape[0][1] - want[1]) < 0.003);
    await page.click('#fit');
    assert.equal(await page.evaluate(() => (window as any).gakuya.left.zoom.scale), 1, 'one click back to the whole picture');
    assert.deepEqual(a.errors, []);
  } finally { await a.close(); }
});

test('stopping right after moving back does not return to where playback was', async () => {
  const a = await startApp(browser, await video());
  try {
    const { page } = a;
    await page.click('#play');
    await page.waitForFunction(() => (document.querySelector('#left video') as HTMLVideoElement).currentTime > 1.5);
    await page.evaluate(async () => {
      const v = (window as any).gakuya.left;
      await v.pause();
      await v.seek(5);
      await v.play();
      await v.pause();
    });
    await still(page);
    const s = await shown(page);
    assert.ok(s.label < 15, `stopped on ${s.label}`);
    assert.equal(s.bits, s.label);
  } finally { await a.close(); }
});
