import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeBitVideo, openChrome, startApp, settled, type App, type Browser, type Page } from './helpers.ts';

let browser: Browser, app: App, video: string;
before(async () => {
  browser = await openChrome();
  video = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' });
  app = await startApp(browser, video);
});
after(async () => { await app?.close(); await browser?.close(); });

const fresh = async () => { await app.page.reload(); await app.page.waitForFunction(() => /コマ 0 /.test(document.getElementById('frame-no')?.textContent ?? '')); };
const pic = async (p: Page) => (await p.locator('#left .content').boundingBox())!;
const bar = async (p: Page) => (await p.locator('#timeline canvas').boundingBox())!;
const lastNote = () => app.store.review.notes.at(-1)!;

/** Fraction of pixels in a snapshot showing the warm mark color. */
function markPixels(page: Page, file: string): Promise<number> {
  return page.evaluate(async (file) => {
    const img = new Image();
    img.src = `/notes/${file}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 210 && d[i + 2] < 90) n++;
    return n;
  }, file);
}

test('drag a range, circle a spot, write a line: all of it lands in the note with marked and raw images', async () => {
  await fresh();
  const { page } = app;
  const t = await bar(page);
  await page.mouse.move(t.x + t.width * 0.2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width * 0.3, t.y + t.height / 2, { steps: 4 });
  await page.mouse.up();
  const r = await pic(page);
  const at = (x: number, y: number): [number, number] => [r.x + r.width * x, r.y + r.height * y];
  await page.mouse.move(...at(0.4, 0.4));
  await page.mouse.down();
  await page.mouse.move(...at(0.6, 0.4), { steps: 3 });
  await page.mouse.move(...at(0.6, 0.6), { steps: 3 });
  await page.mouse.up();
  await page.fill('#note-text', '袖に肌色');
  await page.click('#note-send');
  await page.waitForFunction(() => document.querySelectorAll('#notes-list .note').length === 1);
  const n = lastNote();
  assert.ok(Math.abs(n.frames[0] - 60) <= 2 && Math.abs(n.frames[1] - 90) <= 2, `range ${n.frames}`);
  assert.equal(n.text, '袖に肌色');
  assert.ok(n.anchor.shape.length >= 3);
  assert.ok(Math.abs(n.anchor.shape[0][0] - 0.4) < 0.01 && Math.abs(n.anchor.shape[0][1] - 0.4) < 0.01, `shape ${n.anchor.shape[0]}`);
  assert.equal(n.color, null);
  const frames = new Set(n.snapshots.map((s) => Number(/-(\d+)-/.exec(s)![1])));
  for (const f of [n.frames[0], Math.round((n.frames[0] + n.frames[1]) / 2), n.frames[1], n.anchor.frame]) assert.ok(frames.has(f), `snapshot of frame ${f}`);
  assert.equal(n.snapshots.length, frames.size * 2);
  const marked = n.snapshots.find((s) => s.endsWith('marked.png'))!, raw = n.snapshots.find((s) => s.endsWith('raw.png'))!;
  assert.ok((await markPixels(page, marked)) > 50, 'marked image shows the mark');
  assert.equal(await markPixels(page, raw), 0, 'raw image does not');
  assert.equal(await page.inputValue('#note-text'), '', 'the composer is cleared');
  assert.deepEqual(app.errors, []);
});

test('with no range the note covers the current frame, and a click is a one-point mark', async () => {
  await fresh();
  const { page } = app;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await settled(page, 2);
  const r = await pic(page);
  await page.mouse.click(r.x + r.width * 0.5, r.y + r.height * 0.5);
  await page.fill('#note-text', 'ここ');
  const count = app.store.review.notes.length;
  await page.click('#note-send');
  await page.waitForFunction((c) => document.querySelectorAll('#notes-list .note').length === c + 1, count);
  const n = lastNote();
  assert.deepEqual(n.frames, [2, 2]);
  assert.equal(n.anchor.frame, 2);
  assert.equal(n.anchor.shape.length, 1);
});

test('a range and a sentence are enough, and an empty note cannot be sent', async () => {
  await fresh();
  const { page } = app;
  assert.equal(await page.isDisabled('#note-send'), true);
  await page.fill('#note-text', '音が気持ち悪い');
  assert.equal(await page.isDisabled('#note-send'), false);
  const count = app.store.review.notes.length;
  await page.click('#note-send');
  await page.waitForFunction((c) => document.querySelectorAll('#notes-list .note').length === c + 1, count);
  assert.deepEqual(lastNote().anchor.shape, []);
});

test('marking while zoomed saves the same picture position', async () => {
  await fresh();
  const { page } = app;
  const box = (await page.locator('#left .viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForFunction(() => (window as any).gakuya.left.zoom.scale > 1);
  const x = box.x + box.width / 2 + 30, y = box.y + box.height / 2 + 20;
  const expected = await page.evaluate(([x, y]) => (window as any).gakuya.left.toNorm(x, y), [x, y]);
  await page.mouse.click(x, y);
  await page.fill('#note-text', '拡大中');
  const count = app.store.review.notes.length;
  await page.click('#note-send');
  await page.waitForFunction((c) => document.querySelectorAll('#notes-list .note').length === c + 1, count);
  const got = lastNote().anchor.shape[0];
  assert.ok(Math.abs(got[0] - expected[0]) < 0.002 && Math.abs(got[1] - expected[1]) < 0.002);
});

test('a color can be attached by picker or eyedropper, and the picture does not change', async () => {
  await fresh();
  const { page } = app;
  const pixels = () => page.evaluate(() => (document.querySelector('#left canvas.picture') as HTMLCanvasElement).toDataURL());
  const before = await pixels();
  await page.locator('#note-color').fill('#ff0000');
  await page.fill('#note-text', '赤く');
  let count = app.store.review.notes.length;
  await page.click('#note-send');
  await page.waitForFunction((c) => document.querySelectorAll('#notes-list .note').length === c + 1, count);
  assert.equal(lastNote().color, '#ff0000');
  assert.equal(await pixels(), before);

  // frame 0 is all black; the eyedropper reads the picture
  await page.click('#note-eyedrop');
  const r = await pic(page);
  await page.mouse.click(r.x + r.width * 0.5, r.y + r.height * 0.5);
  await page.fill('#note-text', 'この色');
  count = app.store.review.notes.length;
  await page.click('#note-send');
  await page.waitForFunction((c) => document.querySelectorAll('#notes-list .note').length === c + 1, count);
  const n = lastNote();
  assert.equal(n.color, '#000000');
  assert.deepEqual(n.anchor.shape, [], 'the eyedropper click is not a mark');
});

test('a click on the timeline seeks there', async () => {
  await fresh();
  const { page } = app;
  const t = await bar(page);
  await page.mouse.click(t.x + t.width * 0.5, t.y + t.height / 2);
  const label = await page.waitForFunction(() => {
    const m = /コマ (\d+)/.exec(document.getElementById('frame-no')?.textContent ?? '');
    return m && Number(m[1]) > 100 ? Number(m[1]) : null;
  });
  assert.ok(Math.abs(Number(await label.jsonValue()) - 150) <= 2);
});

test('a proposal arriving while the person is writing leaves their work and the picture alone', async () => {
  const a = await startApp(browser, video);
  try {
    const { page, store } = a;
    const other = await store.createNote({ frames: [40, 50], anchor: { frame: 45, shape: [[0.1, 0.1]] }, text: 'さっきの指摘' });
    await store.wait();
    await page.keyboard.press('ArrowRight');
    await settled(page, 1);
    const r = (await page.locator('#left .content').boundingBox())!;
    await page.mouse.click(r.x + r.width * 0.6, r.y + r.height * 0.6);
    await page.fill('#note-text', '書きかけ');
    await store.propose(other.id, { frames: [40, 50], region: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], text: 'ここですか？' });
    const card = `#notes-list .note[data-note="${other.id}"]`;
    await page.waitForSelector(`${card} button.yes`);
    await page.waitForTimeout(300);
    assert.match(await page.locator('#frame-no').innerText(), /コマ 1 /, 'the picture stays');
    assert.equal(await page.inputValue('#note-text'), '書きかけ');
    assert.equal(await page.locator('#left svg circle').count(), 1, 'the mark stays');
    await page.click(`${card} .meta`);
    await settled(page, 40);
    await page.waitForSelector('#left svg polygon.ai-region');
  } finally { await a.close(); }
});
