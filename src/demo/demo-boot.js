// demo-boot.js
//
// The demo build's entry path, called from main.js when isDemo is true. It
// wires the in-memory store (demo-store.js) into the exact globals the
// existing UI already reads — window.beatBank and window.beatboxApi — and
// puts up the demo chrome (badge, intro toast, mock checkout, "in
// development" markers). Nothing in the classic scripts changes.

import './demo.css';
import { extractPeaks } from '../tagger.js';
import * as store from './demo-store.js';
import { openMockCheckout } from './demo-checkout.js';
import { mountDemoChrome } from './demo-chrome.js';
import { RIGHTS_WARRANTY_TEXT, FREE_TERMS_TEXT } from '../beats-repo.js';

export async function initDemo() {
  // Seed the live beatBank array in place — same contract the real loadBeats
  // relies on (carousel.js captured it by reference; mutate, never reassign).
  const beats = await store.fetchBeats();
  if (Array.isArray(window.beatBank)) {
    window.beatBank.splice(0, window.beatBank.length, ...beats);
    // filteredBeats (not beatBank) is what carousel.js/list-view.js actually
    // render and what transport.js indexes into — recompute it or the demo
    // catalog stays permanently empty behind the filter system.
    window.beatFilters?.apply?.();
    window.beatCarousel?.rebuild?.();
    window.beatList?.rebuild?.();
  }

  // The bridge upload.js and list-view.js call through. Same surface as the
  // real one in main.js, but every backend function points at the store, and
  // the two that run ffmpeg are stubbed so a demo upload is instant.
  window.beatboxApi = {
    isConfigured: true,

    createBeat: store.createBeat,

    // No ffmpeg in the demo: hand the clean file straight back as the
    // "preview", and skip peak extraction (the transport measures on play).
    tagBeat: async ({ beatFile }) => beatFile,
    extractPeaks: async (file) => {
      try { return await extractPeaks(file); } catch { return null; }
    },

    getMasterDownloadUrl: store.getMasterDownloadUrl,
    claimFreeBeat: store.claimFreeBeat,
    getSession: store.getSession,

    // Already a producer in the demo; becoming one is a no-op.
    becomeProducer: async () => store.getSessionSync(),

    // Intercept buying: never send a visitor to a real checkout. Open the
    // mock checkout and return null so list-view.js does not also window.open.
    buildBuyUrl: async (beat) => {
      openMockCheckout(beat, store);
      return null;
    },

    listPurchases: store.listPurchases,
    ownsBeat: store.ownsBeat,
    reloadBeats: reloadBeats,

    RIGHTS_WARRANTY_TEXT,
    FREE_TERMS_TEXT,
  };

  // Re-sync the carousel/list from the store — used after an upload or a
  // completed mock purchase so new beats and ownership changes show up.
  async function reloadBeats() {
    const fresh = await store.fetchBeats();
    if (!Array.isArray(window.beatBank)) return;
    window.beatBank.splice(0, window.beatBank.length, ...fresh);
    window.beatFilters?.apply?.();
    window.beatCarousel?.rebuild?.();
    window.beatList?.rebuild?.();
  }
  window.beatboxDemo = { store, reloadBeats };

  // Demo chrome: the DEMO badge, the signed-in bar, the one-time intro
  // notice, and the "in development" markers on unbuilt areas (offers,
  // library, messaging).
  mountDemoChrome(store);
}
