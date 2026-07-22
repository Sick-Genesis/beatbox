// tagger.js
//
// Laces a tag into a beat IN THE BROWSER, using ffmpeg.wasm.
//
// Why here and not on a server: the person tagging is the person who owns
// the beat. They already have the clean file — it is theirs. So doing this
// client-side gives up nothing. The security property that matters is that
// BUYERS never get the clean file, and that is untouched: the master
// uploads to the private bucket, and only this tagged result goes public.
//
// This also means tagging is free and scales for free — each upload spends
// the uploader's CPU, not ours. It replaces the server-side approach that
// could not run on Supabase Edge Functions anyway (no ffmpeg there).
//
// Requirements:
//   - SharedArrayBuffer, i.e. a cross-origin-isolated page. vite.config.js
//     sets the COOP/COEP headers that provide it.
//   - The ffmpeg core served same-origin (the CSP blocks CDN loads), which
//     is why the core URLs below are bundled via ?url imports.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// The core is served from the public dir rather than imported through the
// package, because @ffmpeg/core's exports map does not expose these deep
// paths for a bundler to resolve. copy-ffmpeg-core in package.json places
// them here from node_modules; they are gitignored, not committed.
const coreURL = '/ffmpeg/ffmpeg-core.js';
const wasmURL = '/ffmpeg/ffmpeg-core.wasm';

const TAG_INTERVAL = 15;   // seconds between tag placements
const TAG_GAIN = 0.8;      // tag volume relative to the beat
const TAG_MAX_SEC = 3;     // producer tags longer than this are rejected

let ffmpeg = null;
let loadPromise = null;

/** Whether this browser can tag at all. */
export function canTagInBrowser() {
  return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true;
}

/** Load ffmpeg once, lazily. Its core is ~30 MB, so not on page load. */
async function ensureLoaded(onProgress) {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    if (onProgress) {
      instance.on('progress', ({ progress }) => onProgress(progress));
    }
    await instance.load({
      // toBlobURL keeps the fetch same-origin-friendly and lets the worker
      // load the core it needs.
      coreURL: await toBlobURL(coreURL, 'text/javascript'),
      wasmURL: await toBlobURL(wasmURL, 'application/wasm'),
    });
    ffmpeg = instance;
    return instance;
  })();

  return loadPromise;
}

/**
 * Return a tagged MP3 File built from a clean beat and a tag.
 *
 * @param {File} beatFile  the clean master (never leaves the browser here)
 * @param {File} tagFile   the tag to lace in
 * @param {(p:number)=>void} [onProgress]  0..1
 * @returns {Promise<File>} tagged preview, as an MP3 File
 */
export async function tagBeat(beatFile, tagFile, onProgress) {
  if (!canTagInBrowser()) {
    throw new Error('This browser cannot generate the preview. Try a desktop browser, or upload your own tagged preview.');
  }

  const ff = await ensureLoaded(onProgress);

  await ff.writeFile('beat', await fetchFile(beatFile));
  await ff.writeFile('tag', await fetchFile(tagFile));

  // Reject an over-long tag: a producer could otherwise pass their whole
  // track as a "tag" and there would be nothing left to sell.
  const tagSeconds = await probeDuration(ff, 'tag');
  if (tagSeconds > TAG_MAX_SEC + 0.25) {
    throw new Error(`Tags need to be ${TAG_MAX_SEC} seconds or shorter.`);
  }

  const duration = await probeDuration(ff, 'beat');

  // Place a tag every interval, but never within the last second.
  const placements = [];
  for (let t = TAG_INTERVAL; t < duration - 1; t += TAG_INTERVAL) {
    placements.push(t);
  }
  // A clip shorter than one interval still gets a single tag up front.
  if (placements.length === 0) placements.push(0);

  // Delay a copy of the tag to each placement, then mix them all into the
  // beat. duration=first holds the output to the beat's length rather than
  // stretching to the last tag.
  const delays = placements
    .map((t, i) => `[1:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},volume=${TAG_GAIN}[t${i}]`)
    .join(';');
  const mixInputs = placements.map((_, i) => `[t${i}]`).join('');
  const filter =
    `${delays};[0:a]${mixInputs}amix=inputs=${placements.length + 1}:duration=first:dropout_transition=0[out]`;

  await ff.exec([
    '-i', 'beat',
    '-i', 'tag',
    '-filter_complex', filter,
    '-map', '[out]',
    '-b:a', '192k',
    'out.mp3',
  ]);

  const data = await ff.readFile('out.mp3');
  const blob = new Blob([data.buffer], { type: 'audio/mpeg' });

  const base = beatFile.name.replace(/\.[^.]+$/, '');
  return new File([blob], `${base}-preview.mp3`, { type: 'audio/mpeg' });
}

/**
 * ffmpeg prints the input duration to its log. Run a no-output decode and
 * scrape it, so the number of tags matches the beat's real length.
 */
async function probeDuration(ff, file) {
  let seconds = 0;
  const onLog = ({ message }) => {
    const m = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  };
  ff.on('log', onLog);
  try {
    await ff.exec(['-i', file, '-f', 'null', '-']);
  } catch {
    // A non-zero exit here is fine — we only want the logged duration.
  }
  ff.off('log', onLog);
  return seconds || 120;   // sane fallback rather than zero placements
}
