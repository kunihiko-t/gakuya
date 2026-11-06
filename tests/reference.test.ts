import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeBitVideo, openChrome, startApp, shown, settled, type App, type Browser, type Page } from './helpers.ts';

let browser: Browser, v: string, ref: string, app: App;
before(async () => {
  browser = await openChrome();
  v = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' });
  ref = await makeBitVideo({ fps: 24, frames: 240, name: 'bits24.mp4' });
});
after(async () => { await app?.close(); await browser?.close(); });

/** Which right frame holds left frame `f` at this offset, computed from the two frame rates. */
const expected = (f: number, offset: number) => Math.floor((f / 30 + offset) * 24);
const rightIs = (page: Page, f: number) => page.waitForFunction((want) => {
  const g = (window as any).gakuya;
  return !g.right.drawing && !g.left.drawing && document.querySelector('#right')?.getAttribute('data-frame') === String(want);
}, f);
const stepTo = async (page: Page, f: number) => {
  await page.evaluate((n) => (window as any).gakuya.left.seek(n), f);
  await settled(page, f);
};

test('a reference plays beside the video, follows it with an offset, and is only ever pointed to', async () => {
  app = await startApp(browser, v);
  const { page, store } = app;
  await page.selectOption('#compare-pick', 'reference');
  await page.fill('#ref-path', ref);
  await page.press('#ref-path', 'Enter');
  await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
  assert.match(await page.locator('#reference-bar').innerText(), /この PC/, 'says the path is on the machine running the server');
  assert.match(await page.locator('#right .pane-label').innerText(), /見本/);

  await stepTo(page, 7);
  await rightIs(page, expected(7, 0));
  assert.equal((await shown(page, 'right')).bits, expected(7, 0));

  await page.fill('#ref-offset', '0.5');
  await page.press('#ref-offset', 'Enter');
  await rightIs(page, expected(7, 0.5));
  assert.equal((await shown(page, 'right')).bits, expected(7, 0.5));
  await page.locator('#ref-offset').blur();
  await page.keyboard.press('ArrowRight');
  await settled(page, 8);
  await rightIs(page, expected(8, 0.5));
  assert.equal((await shown(page, 'right')).bits, expected(8, 0.5));

  // Stopping lines the two up as well.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => { const g = (window as any).gakuya; return !g.left.video.paused && g.left.video.currentTime > 1; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => { const g = (window as any).gakuya; return g.left.canvas.dataset.state === 'still' && g.right.canvas.dataset.state === 'still'; });
  const l = (await shown(page, 'left')).bits;
  await rightIs(page, expected(l, 0.5));
  assert.equal((await shown(page, 'right')).bits, expected(l, 0.5));

  // Nothing of the reference is copied in.
  assert.deepEqual(readdirSync(join(store.dir, 'versions')), ['v1.mp4']);
  const saved = JSON.parse(readFileSync(join(store.dir, 'review.json'), 'utf8'));
  assert.deepEqual(saved.reference, { path: ref, offsetSeconds: 0.5 });
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined as unknown as App;
});

test('a path that cannot be read says why and changes nothing', async () => {
  app = await startApp(browser, v);
  const { page, store } = app;
  await page.selectOption('#compare-pick', 'reference');
  await page.fill('#ref-path', '/no/such/video.mp4');
  await page.press('#ref-path', 'Enter');
  await page.waitForFunction(() => /読めません/.test(document.getElementById('ref-error')!.textContent!));
  assert.equal(store.review.reference, null);
  await app.close();
  app = undefined as unknown as App;
});

test('a set reference opens by itself; once its file is gone it says so and the rest works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gakuya-ref-'));
  const copy = join(dir, '見本 1.mp4');
  copyFileSync(ref, copy);
  app = await startApp(browser, v);
  const { page, store } = app;
  await store.setReference({ path: copy, offsetSeconds: 0 });
  await page.reload();
  await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
  assert.equal(await page.inputValue('#compare-pick'), 'reference');
  assert.equal(await page.inputValue('#ref-path'), copy);

  rmSync(copy);
  assert.equal(existsSync(copy), false);
  await page.reload();
  await page.waitForFunction(() => /見本が見つかりません/.test(document.getElementById('right')!.textContent!));
  await page.keyboard.press('ArrowRight');
  await settled(page, 1);
  assert.equal((await shown(page, 'left')).bits, 1);
  await page.click('#play');
  await page.waitForFunction(() => { const v = document.querySelector('#left video') as HTMLVideoElement; return !v.paused && v.currentTime > 0.3; });
  await page.click('#play');
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined as unknown as App;
});

test('during playback a small drift is closed by speed, without the right picture jumping', async () => {
  app = await startApp(browser, v);
  const { page } = app;
  await page.selectOption('#compare-pick', 'reference');
  await page.fill('#ref-path', ref);
  await page.press('#ref-path', 'Enter');
  await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
  const r = await page.evaluate(async () => {
    const g = (window as any).gakuya, l = g.left.video as HTMLVideoElement, r = g.right.video as HTMLVideoElement;
    await g.left.play();
    await new Promise((ok) => setTimeout(ok, 500));
    r.currentTime = r.currentTime + 0.15;
    await new Promise((ok) => r.addEventListener('seeked', ok, { once: true }));
    let seeks = 0;
    r.addEventListener('seeking', () => seeks++);
    await new Promise((ok) => setTimeout(ok, 3000));
    const drift = Math.abs(l.currentTime - r.currentTime);
    await g.left.pause();
    return { seeks, drift, rate: r.playbackRate };
  });
  assert.equal(r.seeks, 0, 'no jumps');
  assert.ok(r.drift < 0.05, `drift ${r.drift}`);
  assert.equal(r.rate, 1, 'normal speed again after stopping');
  await app.close();
  app = undefined as unknown as App;
});
