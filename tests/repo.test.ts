import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const checked = files.filter((f) => f !== 'tests/repo.test.ts' && f !== 'package-lock.json' && existsSync(f));
// Names that must stay out live in this ignored file, one regular expression, so the check does not publish them.
const local = existsSync('.banned-words') ? `|${readFileSync('.banned-words', 'utf8').trim()}` : '';

test('no personal material or machine-specific paths', () => {
  assert.ok(checked.length > 20, `checked ${checked.length} files`);
  const banned = new RegExp(`/Users/|/Volumes/${local}`, 'i');
  const hits = checked.filter((f) => banned.test(f) || banned.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('generated and personal files stay out of git', () => {
  for (const name of ['.gakuya/', 'dist/', 'node_modules/', 'tests/.tmp/']) assert.ok(readFileSync('.gitignore', 'utf8').includes(name.replace(/\/$/, '')), name);
  assert.deepEqual(files.filter((f) => /\.(mp4|mov|webm|vrm|vmd|fbx|wav)$/i.test(f)), []);
});

test('the license is MIT, and mediabunny is the only runtime dependency', () => {
  assert.match(readFileSync('LICENSE', 'utf8'), /^MIT License/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.dependencies), ['mediabunny']);
});

test('the skill says how to stay in the loop, and never to fix before a yes', () => {
  const skill = readFileSync('skills/gakuya/SKILL.md', 'utf8');
  for (const word of ['gakuya wait', 'run_in_background', 'marked', 'raw', 'gakuya propose', 'gakuya done']) assert.ok(skill.includes(word), word);
  assert.match(skill, /do not (start|begin) (fixing|the fix)[^.]*until[^.]*`yes`/i);
  assert.match(skill, /start the next `?gakuya wait`?/i);
});

test('the README covers install, formats, .gakuya and what is not done', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const word of ['npm install', 'H.264', '.gakuya/', 'Not supported']) assert.ok(readme.includes(word), word);
});
