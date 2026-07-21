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
  fetchBeats, syncInto, createBeat, awaitPreview, getMasterDownloadUrl,
  RIGHTS_WARRANTY_TEXT,
} from './beats-repo.js';
import { isConfigured } from './supabase-client.js';
import { initAuthUI } from './auth-ui.js';
import { getSession, becomeProducer } from './auth.js';

// upload.js is a classic script and cannot import ES modules, so the
// pieces it needs are published on window. Same bridge the rest of this
// layer already uses (window.beatBank, window.beatCarousel).
window.beatboxApi = {
  isConfigured,
  createBeat,
  awaitPreview,
  getMasterDownloadUrl,
  getSession,
  becomeProducer,
  reloadBeats: loadBeats,
  RIGHTS_WARRANTY_TEXT,
};

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
loadBeats();
