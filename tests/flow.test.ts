import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeBitVideo, openChrome, startApp, shown, settled, type App, type Browser } from './helpers.ts';

let browser: Browser, app: App, v1: string, v2: string;
const input = { frames: [10, 20] as [number, number], anchor: { frame: 12, shape: [[0.4, 0.6]] as [number, number][] }, text: '袖に肌色' };

before(async () => {
  browser = await openChrome();
  v1 = await makeBitVideo({ fps: 30, frames: 300, name: 'bits30.mp4' });
  v2 = await makeBitVideo({ fps: 30, frames: 301, name: 'bits30b.mp4' });
});
after(async () => { await app?.close(); await browser?.close(); });

async function fresh() { await app?.close(); app = await startApp(browser, v1); return app; }
function wait() { return fetch(`http://127.0.0.1:${app.srv.port}/api/wait`, { headers: { authorization: `Bearer ${app.srv.token}` } }).then((r) => r.json()); }
const card = (id: string) => `#notes-list .note[data-note="${id}"]`;

test('a proposal shows its region and range, and only yes produces a yes', async () => {
  await fresh();
  const { store, page } = app;
  const n = await store.createNote(input);
  await store.wait();
  await store.propose(n.id, { frames: [11, 19], region: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]], text: 'ここですか？' });
  await page.waitForSelector(`${card(n.id)} button.yes`);
  assert.match(await page.locator(card(n.id)).innerText(), /ここですか？/);
  await page.waitForSelector('#left svg polygon.ai-region');
  assert.deepEqual(await page.evaluate(() => (window as any).gakuya.timeline.aiRange), [11, 19]);
  await settled(page, 11);
  assert.equal(store.nextEvent(), null, 'nothing goes to the agent before an answer');
  const got = wait();
  await page.click(`${card(n.id)} button.yes`);
  const r = await got;
  assert.equal(r.event.type, 'yes');
  assert.equal(store.note(n.id).status, 'confirmed');
});

test('no carries a reason and the corrected mark and range', async () => {
  await fresh();
  const { store, page } = app;
  const n = await store.createNote(input);
  await store.wait();
  await store.propose(n.id, { frames: [11, 19], region: [[0.1, 0.1]], text: 'ここですか？' });
  await page.waitForSelector(`${card(n.id)} button.no`);
  await page.fill(`${card(n.id)} input.reason`, '反対の腕');
  const r = (await page.locator('#left .content').boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.75, r.y + r.height * 0.5);
  assert.equal(await page.inputValue(`${card(n.id)} input.reason`), '反対の腕', 'the draft survives re-rendering');
  const got = wait();
  await page.click(`${card(n.id)} button.no`);
  const e = await got;
  assert.equal(e.event.type, 'no');
  assert.equal(e.event.reason, '反対の腕');
  const after = store.note(n.id);
  assert.equal(after.status, 'open');
  assert.ok(Math.abs(after.anchor.shape[0][0] - 0.75) < 0.01, 'the corrected mark replaced the old one');
  assert.ok(after.snapshots.some((s) => s.endsWith('marked.png')), 'new images were made for the corrected mark');
});

test('the page says when no agent is waiting, and stops saying it once one is', async () => {
  await fresh();
  const { page, store } = app;
  await page.waitForFunction(() => /AI は待機していません/.test(document.getElementById('side')!.textContent!));
  const pending = wait();
  await page.waitForFunction(() => /AI が待機しています/.test(document.getElementById('side')!.textContent!));
  await store.createNote(input);
  await pending;
});

test('done puts old and new side by side on the same frame, in lockstep', async () => {
  await fresh();
  const { store, page } = app;
  const a = await store.createNote(input), other = await store.createNote({ ...input, text: '別の指摘' });
  await store.propose(a.id, { frames: [11, 19], region: [[0.1, 0.1]], text: '?' });
  await store.answer(a.id, { answer: 'yes' });
  await store.done(a.id, v2);
  await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
  await page.waitForSelector(`${card(a.id)} button.resolved`);
  assert.match(await page.locator(card(other.id)).innerText(), /前の版の指摘/);
  assert.doesNotMatch(await page.locator(card(a.id)).innerText(), /前の版の指摘/);
  await settled(page, 11);
  await page.keyboard.press('ArrowRight');
  await settled(page, 12);
  await page.waitForFunction(() => document.querySelector('#right')?.getAttribute('data-frame') === '12');
  assert.equal((await shown(page, 'left')).bits, 12);
  assert.equal((await shown(page, 'right')).bits, 12);
  // zoom follows
  const box = (await page.locator('#left .viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => { const g = (window as any).gakuya; return g.left.zoom.scale > 1 && g.right.zoom.scale === g.left.zoom.scale; });
  // playback moves both and stopping aligns them
  await page.evaluate(() => (window as any).gakuya.left.setZoom({ scale: 1, x: 0, y: 0 }));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => { const g = (window as any).gakuya; return !g.left.video.paused && !g.right.video.paused && g.left.video.currentTime > 0.8; });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const g = (window as any).gakuya;
    return g.left.canvas.dataset.state === 'still' && g.right.canvas.dataset.state === 'still' && g.right.frame === g.left.frame && !g.left.drawing && !g.right.drawing;
  });
  const l = await shown(page, 'left'), r = await shown(page, 'right');
  assert.equal(l.bits, r.bits, 'stopped on the same frame');
  assert.ok(l.bits > 12);
  // verdicts
  await page.fill(`${card(a.id)} input.reason`, 'まだ残ってる');
  const got = wait();
  await page.click(`${card(a.id)} button.not-yet`);
  const events: any[] = [await got];
  while (events.at(-1).event.type !== 'not_yet') events.push(await wait());
  assert.equal(events.at(-1).event.reason, 'まだ残ってる');
  assert.equal(store.note(a.id).status, 'confirmed');
  await store.done(a.id, v2);
  await page.click(`${card(a.id)} button.resolved`);
  await page.waitForFunction((sel) => /解決/.test(document.querySelector(sel)!.textContent!), card(a.id));
  assert.equal(store.note(a.id).status, 'resolved');
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined as unknown as App;
});
