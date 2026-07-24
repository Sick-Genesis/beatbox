// main.js
//
// Entry point. Loads real beats from Supabase and hands them to the
// existing scripts, which keep working unchanged.
//
// Load order matters and is enforced by index.html: beat-data.js defines
// window.beatBank with placeholder rows, then carousel.js captures that
// array by reference, and only then does this module run and swap the
// contents in place. If Supabase is unconfigured or returns nothing, the
// placeholders simply stay — the app still runs.

import {
  fetchBeats, syncInto, createBeat, getMasterDownloadUrl,
  claimFreeBeat, RIGHTS_WARRANTY_TEXT, FREE_TERMS_TEXT,
} from './beats-repo.js';
import { isConfigured } from './supabase-client.js';
import { initAuthUI } from './auth-ui.js';
import { getSession, becomeProducer, onAuthChange } from './auth.js';
import { tagBeat as runTagger, canTagInBrowser, extractPeaks } from './tagger.js';
import {
  buildBuyUrl, claimPendingOrders, listPurchases, ownsBeat,
} from './purchases-repo.js';
import { initChatUI, startDm } from './chat-ui.js';

// The platform tag lives in the public dir (asset/), so it is referenced by
// its served path rather than imported — Vite copies asset/ verbatim.
const platformTagUrl = '/sound/world princess.mp3';

/**
 * Produce a tagged preview in the browser.
 *   mode 'platform' — lace in the beatbox tag
 *   mode 'own_tag'  — lace in the producer's own tag
 * The clean beat never leaves the browser during this — see src/tagger.js.
 */
async function tagBeat({ beatFile, mode, ownTag, onProgress }) {
  if (!canTagInBrowser()) {
    throw new Error(
      'This browser cannot generate the preview. Try a desktop browser, '
      + 'or choose "I\'ll upload my own tagged version".'
    );
  }

  let tagFile = ownTag;
  if (mode === 'platform') {
    const res = await fetch(platformTagUrl);
    const blob = await res.blob();
    tagFile = new File([blob], 'platform-tag.mp3', { type: 'audio/mpeg' });
  }

  if (!tagFile) throw new Error('No tag was provided.');
  return runTagger(beatFile, tagFile, onProgress);
}

// upload.js is a classic script and cannot import ES modules, so the
// pieces it needs are published on window. Same bridge the rest of this
// layer already uses (window.beatBank, window.beatCarousel).
window.beatboxApi = {
  isConfigured,
  createBeat,
  tagBeat,
  extractPeaks,
  getMasterDownloadUrl,
  claimFreeBeat,
  getSession,
  becomeProducer,
  buildBuyUrl,
  listPurchases,
  ownsBeat,
  reloadBeats: loadBeats,
  RIGHTS_WARRANTY_TEXT,
  FREE_TERMS_TEXT,
  startDm,
};

// When someone signs in, attach any purchases that were waiting on their
// email (bought while signed out, or with a different email), then refresh
// so newly-unlocked beats reflect it.
onAuthChange(async (session) => {
  if (!session) return;
  const claimed = await claimPendingOrders();
  if (claimed > 0) {
    console.info(`[beatbox] Attached ${claimed} earlier purchase(s).`);
    loadBeats();
  }
});

// True once real data has replaced the placeholders. Needed because an
// empty fetch is ambiguous: on first load it means "new project, keep the
// placeholders", but after an upload it would mean "everything was
// deleted" — and returning early there would leave a stale carousel.
let showingRealData = false;

async function loadBeats() {
  if (!isConfigured) return;

  const beats = await fetchBeats();

  if (!Array.isArray(window.beatBank)) {
    console.warn('[beatbox] beatBank not found; is beat-data.js loaded first?');
    return;
  }

  // A new project has no beats yet. Placeholders are friendlier than a
  // blank carousel — but only before anything real has been shown.
  if (!beats.length && !showingRealData) {
    console.info('[beatbox] No beats in the database yet — showing placeholders.');
    return;
  }

  showingRealData = true;

  syncInto(window.beatBank, beats);

  // Re-render whichever views are already built.
  window.beatCarousel?.rebuild?.();
  window.beatList?.rebuild?.();

  console.info(`[beatbox] Loaded ${beats.length} beat(s).`);
}

initAuthUI();
initChatUI();
loadBeats();
