import { defineConfig } from 'vite';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The classic <script> tags in index.html (aspect-fix, carousel, transport…)
// are intentionally NOT modules — they rely on shared globals and execution
// order. Vite can't bundle those, so it leaves the tags pointing at the
// original filenames and warns. Without help, the files themselves never
// reach dist/ and the built site 404s on all of them.
//
// This plugin copies them verbatim after the bundle is written. The tags in
// index.html keep working unchanged, and only src/main.js goes through the
// module pipeline.
const CLASSIC_SCRIPTS = [
  'aspect-fix.js',
  'theme-toggle.js',
  'beat-data.js',
  'carousel.js',
  'view-toggle.js',
  'upload-toggle.js',
  'upload.js',
  'transport.js',
];

function copyClassicScripts() {
  return {
    name: 'copy-classic-scripts',
    apply: 'build',
    closeBundle() {
      for (const file of CLASSIC_SCRIPTS) {
        const from = resolve(__dirname, file);
        if (!existsSync(from)) {
          this.warn(`classic script missing, not copied: ${file}`);
          continue;
        }
        copyFileSync(from, resolve(__dirname, 'dist', file));
      }
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'asset',
  plugins: [copyClassicScripts()],
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
