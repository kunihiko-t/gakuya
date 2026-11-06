import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, makeBitVideo, startGakuya, TMP, type Running } from './helpers.ts';

let video: string, video2: string;
let store: Running, srv: Running, root: string;
const note = { frames: [10, 20], anchor: { frame: 12, shape: [[0.4, 0.6]] }, text: '袖に肌色' };

function call(path: string, o: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string>; raw?: Buffer } = {}) {
  const headers: Record<string, string> = { ...o.headers };
  const token = o.token === undefined ? srv.token : o.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const payload = o.raw ?? (o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body)));
  return new Promise<{ status: number; text: string; json: any; headers: Record<string, any> }>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path, method: o.method ?? (payload ? 'POST' : 'GET'), headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        ok({ status: res.statusCode!, text, json, headers: res.headers });
      });
    });
    req.on('error', fail);
    req.end(payload);
  });
}

before(async () => {
  video = await makeBitVideo({ fps: 30, frames: 60, name: '踊り 最終.mp4', dir: join(TMP, '空白 日本語') });
  video2 = await makeBitVideo({ fps: 30, frames: 61, name: '踊り 直し.mp4', dir: join(TMP, '空白 日本語') });
  root = mkdtempSync(join(tmpdir(), 'gakuya-http-'));
  store = srv = await startGakuya(video, root);
});
after(async () => { await srv?.close(); });

test('no token is 401, a foreign Origin or Host is 403', async () => {
  assert.equal((await call('/api/review', { token: null })).status, 401);
  assert.equal((await call('/api/review', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/review', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await call('/api/review')).status, 200);
});

test('the key link sets a cookie that works in place of the token', async () => {
  const first = await call(`/?key=${srv.token}`, { token: null });
  assert.equal(first.status, 302);
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  assert.ok(String(first.headers['set-cookie']).includes('HttpOnly'));
  assert.equal((await call('/api/review', { token: null, headers: { cookie } })).status, 200);
  assert.equal((await call('/?key=wrong', { token: null })).status, 401);
});

test('media is served with ranges and by id only', async () => {
  const r = await call('/media/version/v1', { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-length'], '100');
  assert.equal((await call('/media/version/..%2F..%2Freview.json')).status, 404);
  assert.equal((await call('/notes/..%2Freview.json')).status, 404);
  assert.equal((await call('/media/reference')).status, 404);
});

test('a bad note is refused with a reason', async () => {
  for (const bad of [{ ...note, frames: [10, 9999] }, { ...note, frames: [20, 10] }, { ...note, text: 5 }, { ...note, anchor: { frame: 12, shape: [[2, 0]] } }, { ...note, color: 'red' }]) {
    const r = await call('/api/notes', { body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.json.error);
  }
  assert.equal((await call('/api/notes', { raw: Buffer.from('{nope') })).status, 400);
  assert.equal(store.review.notes.length, 0);
});

test('wait holds until an event, an aborted wait delivers nothing, and the next wait gets it', async () => {
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const req = request({ host: '127.0.0.1', port: srv.port, path: '/api/wait', headers: { authorization: `Bearer ${srv.token}` } });
  req.on('error', () => {});
  req.end();
  await sleep(100);
  assert.equal(await srv.waiting(), 1);
  req.destroy();
  await sleep(100);
  assert.equal(await srv.waiting(), 0);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString('base64');
  const shot = (kind: string, data = png) => ({ frame: 12, kind, data });
  assert.equal((await call('/api/notes', { body: { ...note, snapshots: [shot('../x')] } })).status, 400);
  assert.equal((await call('/api/notes', { body: { ...note, snapshots: [shot('raw', 'bm90IGEgcG5n')] } })).status, 400);
  assert.equal(store.review.notes.length, 0, 'a refused note leaves nothing behind');
  const created = await call('/api/notes', { body: { ...note, snapshots: [shot('marked'), shot('raw')] } });
  assert.equal(created.status, 200);
  const id = created.json.id;
  const got = await call('/api/wait');
  assert.equal(got.json.event.type, 'note');
  assert.equal(got.json.note.id, id);
  assert.equal(got.json.snapshots.length, 2, 'the event carries the images: they exist before the agent hears of the note');
  assert.ok(existsSync(got.json.snapshots[0]), 'absolute snapshot path the agent can read');
  assert.equal((await call(`/notes/${store.note(id).snapshots[0]}`)).status, 200);
  assert.equal(store.nextEvent(), null);
  assert.equal(readFileSync(join(root, '.gakuya', 'r', 'review.json'), 'utf8').includes('"events": []'), true);
  // a waiter already holding gets the next event as soon as it happens
  const pending = call('/api/wait');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await call(`/api/notes/${id}/propose`, { body: { frames: [11, 19], region: [[0.1, 0.1]], text: 'ここですか？' } })).status, 200);
  assert.equal((await call(`/api/notes/${id}/answer`, { body: { answer: 'yes' } })).status, 200);
  assert.equal((await pending).json.event.type, 'yes');
  // illegal transitions are 409, and done copes with a path holding spaces and Japanese
  assert.equal((await call(`/api/notes/${id}/answer`, { body: { answer: 'yes' } })).status, 409);
  assert.equal((await call(`/api/notes/${id}/done`, { body: { video: join(root, 'none.mp4') } })).status, 400);
  const done = await call(`/api/notes/${id}/done`, { body: { video: video2 } });
  assert.equal(done.status, 200);
  assert.equal(store.note(id).version, 'v2');
  assert.equal(store.review.versions[1].frames, 61);
});

test('the stream sends the review and the waiter count', async () => {
  const seen = await new Promise<any>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: srv.port, path: '/api/stream', headers: { authorization: `Bearer ${srv.token}` } }, (res) => {
      res.on('data', (c) => { const m = /data: (.*)\n/.exec(c.toString()); if (m) { ok(JSON.parse(m[1])); req.destroy(); } });
    });
    req.on('error', () => {});
    req.end();
    setTimeout(() => fail(new Error('no stream data')), 1000);
  });
  assert.equal(seen.review.name, 'r');
  assert.equal(seen.waiting, 0);
});

test('timing, reference and the analysis cache round trip', async () => {
  assert.equal((await call('/api/timing', { body: { bpm: 128, source: 'manual' } })).status, 200);
  assert.equal(store.review.timing.bpm, 128);
  assert.equal((await call('/api/timing', { body: { bpm: 'fast' } })).status, 400);
  assert.equal((await call('/api/reference', { body: { path: join(root, 'none.mp4'), offsetSeconds: 0 } })).status, 400);
  assert.equal((await call('/api/reference', { body: { path: video, offsetSeconds: 0.5 } })).status, 200);
  assert.equal((await call('/media/reference', { headers: { range: 'bytes=0-9' } })).status, 206);
  assert.equal((await call('/api/reference', { body: null })).status, 200);
  assert.equal(store.review.reference, null);
  assert.equal((await call('/api/analysis/v1')).status, 404);
  assert.equal((await call('/api/analysis/v1', { body: { bpm: 1 } })).status, 200);
  assert.deepEqual((await call('/api/analysis/v1')).json, { bpm: 1 });
  assert.equal((await call('/api/analysis/nope', { body: {} })).status, 404);
});

// --- CLI, as an agent runs it ---

function runCli(cwd: string, ...args: string[]) { return spawnSync(BIN, args, { cwd, encoding: 'utf8' }); }

test('without a server, wait explains how to start and exits 1', () => {
  const r = runCli(mkdtempSync(join(tmpdir(), 'gakuya-cli-')), 'wait');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gakuya <動画>/);
});

test('an agent starting right after launch never reads a half-written server.json', async () => {
  for (let i = 0; i < 40; i++) {
    const cwd = mkdtempSync(join(tmpdir(), 'gakuya-start-'));
    const child = spawn(BIN, [video, '--review', 'r', '--no-open'], { cwd, stdio: 'ignore' });
    const info = join(cwd, '.gakuya', 'r', 'server.json');
    try {
      const end = Date.now() + 5000;
      while (!existsSync(info) && Date.now() < end) { /* as fast as it can look */ }
      assert.ok(JSON.parse(readFileSync(info, 'utf8')).token);
    } finally {
      child.kill('SIGTERM');
      await new Promise((ok) => child.on('exit', ok));
    }
  }
});

test('the CLI drives the flow against a video whose path has spaces and Japanese', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gakuya cli 日本語-'));
  const child: ChildProcess = spawn(BIN, [video, '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise<string>((ok, fail) => {
      child.stdout!.on('data', (d) => { const m = /(http:\/\/127\.0\.0\.1:\d+\/\?key=\w+)/.exec(String(d)); if (m) ok(m[1]); });
      child.stderr!.on('data', (d) => fail(new Error(String(d))));
    });
    const info = join(cwd, '.gakuya', '踊り 最終', 'server.json');
    assert.equal(statSync(info).mode & 0o777, 0o600);
    const { port, token } = JSON.parse(readFileSync(info, 'utf8'));
    assert.ok(url.includes(String(port)));
    const post = (p: string, b: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
    const n = await (await post('/api/notes', note)).json();

    const bad = runCli(cwd, 'propose', n.id, '--frames', '1-2', '--region', 'not json', '--text', 'x');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--region/);
    const out = runCli(cwd, 'propose', n.id, '--frames', '1-2', '--region', '[[0.1,0.2]]', '--text', 'ここですか？');
    assert.equal(out.status, 0, out.stderr);

    const waited = runCli(cwd, 'wait');
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).event.type, 'note');

    await post(`/api/notes/${n.id}/answer`, { answer: 'yes' });
    assert.equal(JSON.parse(runCli(cwd, 'wait').stdout).event.type, 'yes');
    const done = runCli(cwd, 'done', n.id, '--video', video2);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(runCli(cwd, 'timing', '--bpm', '140').status, 0);
    const r = await (await fetch(`http://127.0.0.1:${port}/api/review`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(r.timing.bpm, 140);
    assert.equal(r.timing.source, 'agent');
    assert.equal(r.versions.length, 2);
    assert.equal(runCli(cwd, 'timing', '--bpm', 'fast').status, 1);
  } finally {
    child.kill('SIGTERM');
    await new Promise((ok) => child.on('exit', ok));
  }
});
