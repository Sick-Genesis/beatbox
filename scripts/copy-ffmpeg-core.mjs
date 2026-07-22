// Copy the ffmpeg.wasm core out of node_modules into asset/ffmpeg, where
// the app serves it same-origin (the CSP blocks CDN loads, and the core's
// package exports map does not expose these deep paths for a bundler).
//
// Runs automatically on install, dev and build. The copied files are
// gitignored — they are large (~32 MB) and reproducible from the dependency.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@ffmpeg/core/dist/esm');
const dest = resolve(root, 'asset/ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

if (!existsSync(resolve(src, files[0]))) {
  console.warn('[beatbox] @ffmpeg/core not installed yet — skipping core copy.');
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
for (const f of files) {
  copyFileSync(resolve(src, f), resolve(dest, f));
}
console.log('[beatbox] ffmpeg core copied to asset/ffmpeg/');
