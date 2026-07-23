// gen-demo-peaks.mjs
//
// Reads the generated demo WAV loops and extracts a coarse waveform-peaks
// array for each — the same kind of amplitude summary the real app stores on
// a beat (beats.peaks) and the transport draws. Printing them here lets the
// demo seed data carry accurate waveforms that match what actually plays.
//
// Run:  node scripts/gen-demo-peaks.mjs   (prints a JS snippet to paste)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'asset', 'sound', 'demo');
const BUCKETS = 64; // how many bars the transport waveform draws

function readWavMono(path) {
  const buf = readFileSync(path);
  // minimal WAV parse: assume 16-bit PCM mono, data at offset 44
  const dataLen = buf.readUInt32LE(40);
  const n = dataLen / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return out;
}

function peaks(samples, buckets) {
  const size = Math.floor(samples.length / buckets);
  const out = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    for (let i = 0; i < size; i++) {
      const v = Math.abs(samples[b * size + i] || 0);
      if (v > max) max = v;
    }
    out.push(Math.round(max * 100) / 100);
  }
  return out;
}

for (const name of ['loop-01', 'loop-02', 'loop-03', 'loop-04']) {
  const s = readWavMono(resolve(DIR, `${name}.wav`));
  console.log(`${name}: [${peaks(s, BUCKETS).join(', ')}]`);
}
