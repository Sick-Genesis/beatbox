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
  // Capture the resolved project root and out dir from Vite itself, rather
  // than guessing from __dirname/import.meta — Vite may load this config
  // from a temp directory, which would otherwise point us at the wrong place.
  let root;
  let outDir;
  return {
    name: 'copy-classic-scripts',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const file of CLASSIC_SCRIPTS) {
        const from = resolve(root, file);
        if (!existsSync(from)) {
          this.warn(`classic script missing, not copied: ${file}`);
          continue;
        }
        copyFileSync(from, resolve(outDir, file));
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
    // ffmpeg.wasm needs SharedArrayBuffer, which browsers only expose in a
    // cross-origin-isolated context. These two headers establish that.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // @ffmpeg/ffmpeg ships its worker as a separate chunk; excluding it from
  // dep pre-bundling keeps that worker resolvable at runtime.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
