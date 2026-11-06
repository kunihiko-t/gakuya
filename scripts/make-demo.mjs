// Makes the pictures in the README by running the real binary on two renders of your own, with this script issuing the
// commands an AI agent would. Run `npm run build` first, then `npm run demo -- demo.json`, where demo.json is:
//   { "before": "first render.mp4", "after": "fixed render.mp4", "frame": 90, "range": [85, 159],
//     "center": [0.45, 0.36], "radius": 0.055, "note": "what the person says", "proposal": "what the agent asks" }
// center and radius are in 0..1 of the picture height: where the fault is, on that frame.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const exec = promisify(execFile);
const BIN = resolve('dist/gakuya'), OUT = resolve('docs/media');
const demo = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'gakuya-demo-'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const server = spawn(BIN, [resolve(demo.before), '--review', 'stage', '--no-open'], { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
const link = await new Promise((ok) => server.stdout.on('data', (d) => { const m = /http:\S+/.exec(String(d)); if (m) ok(m[0]); }));
const agent = async (...args) => (await exec(BIN, args, { cwd: work })).stdout;
const listen = () => agent('wait').then(JSON.parse);

const page = await browser.newPage({ viewport: { width: 1180, height: 840 } });
await page.goto(link);
await page.waitForFunction(() => /コマ 0 /.test(document.getElementById('frame-no')?.textContent ?? ''));
await page.waitForFunction(() => Number(document.getElementById('bpm')?.value) > 0, null, { timeout: 120000 });
const { videoWidth: width, videoHeight: height } = await page.evaluate(() => {
  const s = window.gakuya.left.source;
  return { videoWidth: s.width, videoHeight: s.height };
});

// The GIF is built from screenshots, each held for as long as the step deserves.
const shots = [];
const shot = async (hold) => {
  const path = join(work, `shot-${String(shots.length).padStart(4, '0')}.png`);
  await page.screenshot({ path });
  shots.push({ path, hold });
};
const whilePlaying = async (ms) => {
  await page.keyboard.press('Space');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const start = Date.now();
    await shot(0);
    shots.at(-1).hold = (Date.now() - start) / 1000;
  }
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#left canvas.picture').dataset.state === 'still');
};
const settled = (f) => page.waitForFunction((n) => new RegExp(`コマ ${n} `).test(document.getElementById('frame-no').textContent), f);
const goTo = async (f) => {
  await page.evaluate((n) => window.gakuya.left.seek(n), f);
  await settled(f);
};
const ring = (k, r = demo.radius) => [demo.center[0] + (Math.cos(k) * r * height) / width, demo.center[1] + Math.sin(k) * r];
// The agent's outline is a little wider than the person's circle, so both can be seen.
const circle = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => ring((k / 12) * Math.PI * 2, demo.radius * 1.25));

let event = listen();
await page.waitForFunction(() => !/待機していません/.test(document.getElementById('side').textContent));
await shot(1);
await whilePlaying(2500);

// A person stops on the fault and looks closer.
await goTo(demo.frame);
await shot(0.6);
const box = await page.locator('#left .content').boundingBox();
const toScreen = ([u, v]) => [box.x + box.width * u, box.y + box.height * v];
await page.mouse.move(...toScreen(demo.center));
for (let i = 0; i < 3; i++) {
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(80);
  await shot(0.25);
}
await shot(0.8);
await page.keyboard.press('0');
await page.waitForTimeout(100);

// They drag the range, circle the spot, and write a line.
const bar = await page.locator('#timeline canvas').boundingBox();
const frames = await page.evaluate(() => window.gakuya.left.source.frames);
const barX = (f) => bar.x + bar.width * (f / frames);
await page.mouse.move(barX(demo.range[0]), bar.y + bar.height / 2);
await page.mouse.down();
for (let k = 1; k <= 4; k++) {
  await page.mouse.move(barX(demo.range[0] + ((demo.range[1] - demo.range[0]) * k) / 4), bar.y + bar.height / 2);
  await shot(0.12);
}
await page.mouse.up();
await goTo(demo.frame);
await shot(0.4);
await page.mouse.move(...toScreen(ring(0)));
await page.mouse.down();
for (let k = 1; k <= 16; k++) {
  await page.mouse.move(...toScreen(ring((k / 16) * Math.PI * 2)));
  if (k % 4 === 0) await shot(0.12);
}
await page.mouse.up();
await shot(0.4);
await page.locator('#note-text').click();
for (const ch of demo.note) {
  await page.keyboard.insertText(ch);
  await shot(0.08);
}
await shot(0.7);
await page.click('#note-send');
await page.waitForFunction(() => document.getElementById('note-text').value === '');

// The agent wakes, looks at the snapshots, and shows what it understood.
const note = (await event).note;
const card = `#notes-list .note[data-note="${note.id}"]`;
await agent('propose', note.id, '--frames', `${demo.frame}-${demo.range[1]}`, '--region', JSON.stringify(circle), '--text', demo.proposal);
event = listen();
await page.waitForSelector(`${card} button.yes`);
await page.waitForSelector('#left svg polygon.ai-region');
await page.waitForTimeout(500);
await shot(3);
await page.screenshot({ path: join(OUT, 'proposal.png') });

// Yes. The agent fixes it and hands back a new render, which opens beside the old one.
await page.click(`${card} button.yes`);
await event;
await page.waitForTimeout(300);
await shot(1.5);
await agent('done', note.id, '--video', resolve(demo.after));
await page.waitForSelector('#right:not([hidden]) canvas.picture[data-state="still"]');
await page.waitForSelector(`${card} button.resolved`);
await page.waitForFunction((f) => document.querySelector('#right')?.getAttribute('data-frame') === String(f), demo.frame);
await page.waitForTimeout(500);
await shot(3);
await page.screenshot({ path: join(OUT, 'compare.png') });
await whilePlaying(1500);
await goTo(demo.frame);
await shot(1);
await page.click(`${card} button.resolved`);
await page.waitForTimeout(300);
await shot(2.5);
await browser.close();
server.kill('SIGTERM');

const list = shots.map((s) => `file '${s.path}'\nduration ${s.hold.toFixed(3)}`).join('\n') + `\nfile '${shots.at(-1).path}'\n`;
writeFileSync(join(work, 'shots.txt'), list);
await exec('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(work, 'shots.txt'),
  '-vf', 'fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  join(OUT, 'demo.gif')]);
console.log(`wrote ${OUT}, working files in ${work}`);
