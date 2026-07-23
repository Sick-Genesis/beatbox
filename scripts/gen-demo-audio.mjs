// gen-demo-audio.mjs
//
// Generates the demo beat loops as self-contained WAV files, so the demo
// build ships with real, playable audio and zero third-party licensing.
// These are simple synthesized loops — a kick/808 pattern with a bass and a
// sparse melodic layer — distinct enough that each demo beat sounds like its
// own track when clicked through.
//
// Run:  node scripts/gen-demo-audio.mjs
// Output: asset/sound/demo/loop-01.wav … loop-04.wav

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'asset', 'sound', 'demo');
mkdirSync(OUT_DIR, { recursive: true });

const SR = 44100;

// ── tiny synth helpers ───────────────────────────────────────────────────────

const noteHz = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);

// One-shot with an exponential amplitude envelope.
function osc({ buf, start, dur, freq, gain = 0.3, decay = 8, type = 'sine' }) {
  const n = Math.floor(dur * SR);
  const s0 = Math.floor(start * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-decay * t);
    const ph = 2 * Math.PI * freq * t;
    let v;
    if (type === 'sine') v = Math.sin(ph);
    else if (type === 'saw') v = 2 * ((freq * t) % 1) - 1;
    else if (type === 'square') v = Math.sin(ph) >= 0 ? 1 : -1;
    else if (type === 'tri') v = 2 * Math.abs(2 * ((freq * t) % 1) - 1) - 1;
    else v = Math.sin(ph);
    const idx = s0 + i;
    if (idx < buf.length) buf[idx] += v * gain * env;
  }
}

// 808-ish kick: sine with a fast downward pitch sweep.
function kick({ buf, start, gain = 0.9 }) {
  const dur = 0.35;
  const n = Math.floor(dur * SR);
  const s0 = Math.floor(start * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-6 * t);
    const freq = 120 * Math.exp(-18 * t) + 45;
    const idx = s0 + i;
    if (idx < buf.length) buf[idx] += Math.sin(2 * Math.PI * freq * t) * gain * env;
  }
}

// Filtered noise burst, for a hat/snare.
function noise({ buf, start, dur, gain = 0.25, decay = 40 }) {
  const n = Math.floor(dur * SR);
  const s0 = Math.floor(start * SR);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-decay * t);
    // lightly high-passed white noise
    const w = Math.random() * 2 - 1;
    const hp = w - last; last = w;
    const idx = s0 + i;
    if (idx < buf.length) buf[idx] += hp * gain * env;
  }
}

// ── WAV encoder (16-bit PCM mono) ────────────────────────────────────────────

function toWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
  }
  return buf;
}

// Normalize to avoid clipping, leaving a little headroom.
function normalize(buf, peak = 0.9) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return buf;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

// ── the four loops ───────────────────────────────────────────────────────────
//
// Each is a 2-bar loop at its own tempo and key, repeated so the clip runs
// ~16-20s. Kept intentionally short and characterful.

function makeLoop({ bpm, bars = 2, reps, root, style }) {
  const beat = 60 / bpm;
  const barDur = beat * 4;
  const loopDur = barDur * bars;
  const total = loopDur * reps;
  const buf = new Float64Array(Math.ceil(total * SR));

  for (let r = 0; r < reps; r++) {
    const base = r * loopDur;
    for (let b = 0; b < bars; b++) {
      const bar = base + b * barDur;

      // Drums — shared backbone, varied by style.
      for (let step = 0; step < 4; step++) {
        const t = bar + step * beat;
        if (step === 0 || step === 2) kick({ buf, start: t, gain: 0.95 });
        if (step === 1 || step === 3) noise({ buf, start: t, dur: 0.18, gain: 0.35, decay: 30 }); // snare
        // hats on eighths
        noise({ buf, start: t, dur: 0.05, gain: 0.12, decay: 90 });
        noise({ buf, start: t + beat / 2, dur: 0.05, gain: 0.1, decay: 90 });
      }

      // Bass + melody, per style.
      const scale = style === 'dark'
        ? [0, 3, 5, 7, 10]       // minor pentatonic
        : [0, 2, 4, 7, 9];       // major pentatonic
      for (let step = 0; step < 8; step++) {
        const t = bar + step * (beat / 2);
        if (style === 'dark') {
          if (step % 2 === 0) osc({ buf, start: t, dur: beat * 0.6, freq: noteHz(root - 12), gain: 0.4, decay: 3, type: 'tri' });
        } else if (style === 'boom') {
          if (step % 4 === 0) osc({ buf, start: t, dur: beat * 0.9, freq: noteHz(root - 12), gain: 0.45, decay: 2.5, type: 'sine' });
        } else if (style === 'lofi') {
          if (step % 2 === 0) osc({ buf, start: t, dur: beat * 0.7, freq: noteHz(root - 12), gain: 0.35, decay: 4, type: 'sine' });
        } else { // bright
          osc({ buf, start: t, dur: beat * 0.4, freq: noteHz(root - 12), gain: 0.3, decay: 5, type: 'saw' });
        }
        // sparse melody note
        if ((step * 3 + b) % 5 === 0) {
          const deg = scale[(step + b) % scale.length];
          osc({ buf, start: t, dur: beat * 0.5, freq: noteHz(root + deg + 12), gain: 0.22, decay: 6, type: style === 'bright' ? 'square' : 'sine' });
        }
      }
    }
  }

  return normalize(buf);
}

const loops = [
  { name: 'loop-01', bpm: 140, reps: 5, root: -12, style: 'dark' },   // trap, F min-ish
  { name: 'loop-02', bpm: 90,  reps: 4, root: -5,  style: 'boom' },   // boom-bap
  { name: 'loop-03', bpm: 120, reps: 5, root: 0,   style: 'bright' }, // upbeat
  { name: 'loop-04', bpm: 75,  reps: 3, root: -8,  style: 'lofi' },   // lofi
];

for (const l of loops) {
  const samples = makeLoop(l);
  const wav = toWav(Array.from(samples));
  const path = resolve(OUT_DIR, `${l.name}.wav`);
  writeFileSync(path, wav);
  console.log(`wrote ${path} (${(wav.length / 1024).toFixed(0)} KB, ${(samples.length / SR).toFixed(1)}s)`);
}
