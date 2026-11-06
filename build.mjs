// Builds the page, then the binary with the page embedded in it. Node is only needed here, not to run gakuya.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const web = 'cmd/gakuya/web';
mkdirSync(web, { recursive: true });
await build({ entryPoints: ['src/web/main.ts'], bundle: true, format: 'iife', target: 'es2022', outfile: `${web}/main.js`, logLevel: 'warning' });
for (const f of ['index.html', 'style.css']) copyFileSync(`src/web/${f}`, `${web}/${f}`);
execFileSync('go', ['build', '-o', 'dist/gakuya', './cmd/gakuya'], { stdio: 'inherit' });
