import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeBitVideo, openChrome, newPage, bundleForBrowser, serveFiles, READ_BITS, type Browser, type Page } from './helpers.ts';

let browser: Browser, page: Page, srv: Awaited<ReturnType<typeof serveFiles>>;
const videos = {
  '/30.mp4': { fps: 30, frames: 300, name: 'bits30.mp4' },
  '/60.mp4': { fps: 60, frames: 300, name: 'bits60.mp4' },
  '/offset.mp4': { fps: 30, frames: 120, name: 'bits_offset.mp4', startOffset: 0.5 },
  '/vfr.mp4': { fps: 30, frames: 120, name: 'bits_vfr.mp4', vfr: true },
};
const paths: Record<string, string> = {};

before(async () => {
  for (const [route, o] of Object.entries(videos)) paths[route] = await makeBitVideo(o);
  srv = await serveFiles(paths);
  browser = await openChrome();
  page = await newPage(browser);
  await page.goto(srv.url);
  await page.addScriptTag({ content: await bundleForBrowser('src/web/frames.ts', 'Gk') });
});
after(async () => { await browser?.close(); srv?.close(); });

function checkAll(route: string) {
  return page.evaluate(async ({ route, read }) => {
    const readBits = eval(read);
    const src = await (window as any).Gk.FrameSource.open(route);
    const c = document.getElementById('c') as HTMLCanvasElement;
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const wrong: [number, number][] = [];
    const check = async (f: number) => { await src.draw(f, ctx); const n = readBits(ctx); if (n !== f) wrong.push([f, n]); };
    for (let f = 0; f < src.frames; f++) await check(f);
    let seed = 7;
    for (let i = 0; i < 100; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; await check(seed % src.frames); }
    const round = [0, 1, src.frames >> 1, src.frames - 1].every((f) => src.frameAt(src.timeOf(f)) === f);
    src.close();
    return { frames: src.frames, wrong, round };
  }, { route, read: READ_BITS });
}

for (const [route, o] of Object.entries(videos)) {
  test(`every frame of ${o.name} shows the number asked for`, async () => {
    const r = await checkAll(route);
    assert.equal(r.frames, o.frames);
    assert.deepEqual(r.wrong, []);
    assert.equal(r.round, true);
    const probed = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', paths[route]]).toString().trim();
    assert.equal(r.frames, Number(probed));
  });
}
