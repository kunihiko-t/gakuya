import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TMP, makeBitVideo, openChrome, startApp, startGakuya, type App, type Browser, type Page } from './helpers.ts';

let browser: Browser, silent: string, clicks120: string, clicks90: string, wav: string, app: App | null = null;
before(async () => {
  browser = await openChrome();
  silent = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' });
  clicks120 = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30-clicks.mp4', clicks: { bpm: 120, offset: 0.5 } });
  clicks90 = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30-clicks90.mp4', clicks: { bpm: 90, offset: 0.25 } });
  wav = join(TMP, 'clicks90.wav');
  if (!existsSync(wav)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clicks90, '-vn', wav]);
});
after(async () => { await app?.close(); await browser?.close(); });

const open = async (video: string) => {
  await app?.close();
  app = await startApp(browser, video);
  return app;
};
const useFile = async (page: Page, path: string) => {
  await page.selectOption('#sound-pick', 'file');
  await page.fill('#sound-path', path);
  await page.press('#sound-path', 'Enter');
};
const bpmIs = (page: Page, low: number, high: number) => page.waitForFunction(([a, b]) => {
  const v = Number((document.getElementById('bpm') as HTMLInputElement).value);
  return v >= a && v <= b;
}, [low, high]);
const audible = (page: Page) => page.evaluate(() => {
  const g = (window as any).gakuya;
  return { left: !g.left.video.muted, right: !g.right.video.muted, extra: !g.sound.audio.paused };
});
/** Plays for a while and returns how far the sound's clock is from the picture's, plus the offset. */
const playedDrift = (page: Page, offset: number) => page.evaluate(async (off) => {
  const g = (window as any).gakuya, l = g.left.video as HTMLVideoElement, a = g.sound.audio as HTMLAudioElement;
  await g.left.play();
  await new Promise((ok) => setTimeout(ok, 1500));
  const drift = a.currentTime - (l.currentTime + off), playing = !a.paused;
  await g.left.pause();
  return { drift, playing, stopped: a.paused };
}, offset);

test('a sound file plays instead of the video, and the beats come from what is heard', async () => {
  const { page, store } = await open(silent);
  assert.equal((await audible(page)).extra, false);
  await useFile(page, wav);
  await bpmIs(page, 89, 91);
  const r = await playedDrift(page, 0);
  assert.ok(r.playing, 'the sound played');
  assert.ok(r.stopped, 'and stopped with the picture');
  assert.ok(Math.abs(r.drift) < 0.1, `drift ${r.drift}`);
  assert.equal((await audible(page)).left, false, 'the video is silent while another sound is chosen');
  assert.deepEqual(store.review.sound, { path: wav });
  assert.deepEqual(app!.errors, []);
});

test('a video can lend only its sound, and choosing this video again brings its own back', async () => {
  const { page, store } = await open(clicks120);
  await bpmIs(page, 119, 121);
  await useFile(page, clicks90);
  await bpmIs(page, 89, 91);
  assert.equal(await page.locator('#right').isVisible(), false, 'its picture is not shown');
  await page.selectOption('#sound-pick', 'video');
  await bpmIs(page, 119, 121);
  assert.equal((await audible(page)).left, true);
  assert.equal(store.review.sound, null);
});

test('a tempo set by hand stays when the sound changes', async () => {
  const { page, store } = await open(clicks120);
  await bpmIs(page, 119, 121);
  await store.setTiming({ bpm: 100, offset: 0, source: 'manual' });
  await bpmIs(page, 100, 100);
  await useFile(page, wav);
  await page.waitForFunction(() => (window as any).gakuya.timing.heardSound?.bpm > 0);
  await page.waitForTimeout(500);
  assert.equal(store.review.timing.bpm, 100);
  assert.equal(store.review.timing.source, 'manual');
});

test('the reference beside the picture can be the sound, at the reference offset', async () => {
  const { page, store } = await open(silent);
  await store.setReference({ path: clicks90, offsetSeconds: 0.5 });
  await page.reload();
  await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
  await page.selectOption('#sound-pick', 'reference');
  await page.waitForFunction(() => (window as any).gakuya.left.video.muted);
  await bpmIs(page, 89, 91);
  assert.deepEqual(store.review.sound, { reference: true });
  const r = await playedDrift(page, 0.5);
  assert.ok(r.playing);
  assert.ok(Math.abs(r.drift) < 0.1, `drift ${r.drift}`);
  assert.equal((await audible(page)).right, false, 'the sound is not played twice');

  await page.fill('#ref-offset', '1');
  await page.press('#ref-offset', 'Enter');
  await page.waitForFunction(() => (window as any).gakuya.sound.offset === 1);
  const moved = await playedDrift(page, 1);
  assert.ok(Math.abs(moved.drift) < 0.1, `drift ${moved.drift}`);
});

test('a negative offset stays silent until the sound begins', async () => {
  const { page } = await open(silent);
  await useFile(page, wav);
  await page.fill('#sound-offset', '-1');
  await page.press('#sound-offset', 'Enter');
  await page.waitForFunction(() => (window as any).gakuya.sound.offset === -1);
  const r = await page.evaluate(async () => {
    const g = (window as any).gakuya, l = g.left.video as HTMLVideoElement, a = g.sound.audio as HTMLAudioElement;
    await g.left.seek(0);
    await g.left.play();
    await new Promise((ok) => setTimeout(ok, 500));
    const early = a.paused;
    while (l.currentTime < 1.6) await new Promise((ok) => setTimeout(ok, 50));
    const late = a.paused, drift = a.currentTime - (l.currentTime - 1);
    await g.left.pause();
    return { early, late, drift };
  });
  assert.equal(r.early, true, 'silent before the sound begins');
  assert.equal(r.late, false, 'playing after');
  assert.ok(Math.abs(r.drift) < 0.15, `drift ${r.drift}`);
});

test('a bad sound says why, and the video keeps its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gakuya-sound-'));
  const broken = join(dir, 'broken.wav');
  writeFileSync(broken, 'not a sound');
  const notSound = join(dir, 'notes.txt');
  writeFileSync(notSound, 'secret');
  const { page, store } = await open(clicks120);

  await useFile(page, '/no/such/sound.wav');
  await page.waitForFunction(() => /読めません/.test(document.getElementById('sound-error')!.textContent!));
  assert.equal(store.review.sound, null);

  await useFile(page, notSound);
  await page.waitForFunction(() => /音声か動画/.test(document.getElementById('sound-error')!.textContent!));
  assert.equal(store.review.sound, null);
  assert.equal((await store.post('/api/sound', { path: 'relative.wav' }).catch((e: Error) => e.message)).toString().length > 0, true);

  await useFile(page, broken);
  await page.waitForFunction(() => /音を読めません/.test(document.getElementById('sound-error')!.textContent!));
  assert.equal((await audible(page)).left, true, 'an unreadable sound does not leave the page silent');
});

test('--audio chooses the sound from the start, including the reference', async () => {
  const a = await startGakuya(silent, undefined, ['--audio', wav]);
  assert.deepEqual(a.review.sound, { path: wav });
  await a.close();
  const b = await startGakuya(silent, undefined, ['--reference', clicks90, '--audio', 'reference']);
  assert.deepEqual(b.review.sound, { reference: true });
  await b.close();
});
