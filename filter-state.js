// filter-state.js
//
// The filtered view both list-view.js and carousel.js render from, and that
// transport.js indexes into for playback. beatBank stays the full,
// untouched catalog (main.js's syncInto and the rest of the data layer
// depend on that); filteredBeats is a live SUBSET of it, kept in the same
// array identity across filter changes the same way syncInto keeps
// beatBank's identity — by splicing, not reassigning — since carousel.js
// captures its `items` reference once at load time.
//
// Load order: beat-data.js (defines beatBank) must run before this.

window.filterCriteria = {
  tags: new Set(),   // empty = no tag filter
  free: 'all',       // 'all' | 'free' | 'paid'
  bpmMin: null,
  bpmMax: null,
  priceMin: null,    // dollars
  priceMax: null,
};

window.filteredBeats = [];

/** Lowest license price in dollars, or null if free/unpriced. */
function lowestPrice(item) {
  if (item.isFree) return 0;
  const tiers = item.licenses || [];
  if (!tiers.length) return null;
  return Math.min(...tiers.map((t) => t.price_cents)) / 100;
}

function matchesCriteria(item, criteria) {
  if (criteria.tags.size > 0) {
    const itemTags = new Set((item.tags || []).map((t) => t.toLowerCase()));
    let hasAny = false;
    for (const t of criteria.tags) {
      if (itemTags.has(t)) { hasAny = true; break; }
    }
    if (!hasAny) return false;
  }

  if (criteria.free === 'free' && !item.isFree) return false;
  if (criteria.free === 'paid' && item.isFree) return false;

  if (criteria.bpmMin != null && (item.bpm == null || item.bpm < criteria.bpmMin)) return false;
  if (criteria.bpmMax != null && (item.bpm == null || item.bpm > criteria.bpmMax)) return false;

  if (criteria.priceMin != null || criteria.priceMax != null) {
    const price = lowestPrice(item);
    // Unpriced/no-tier beats fall out of any price-bounded filter — there's
    // nothing to compare, and showing them under a $10-30 filter would be
    // more confusing than the exclusion.
    if (price == null) return false;
    if (criteria.priceMin != null && price < criteria.priceMin) return false;
    if (criteria.priceMax != null && price > criteria.priceMax) return false;
  }

  return true;
}

/** Recompute filteredBeats from the current beatBank + filterCriteria. */
function applyFilters() {
  if (typeof beatBank === 'undefined') return;

  const matches = beatBank.filter((item) => matchesCriteria(item, window.filterCriteria));
  window.filteredBeats.splice(0, window.filteredBeats.length, ...matches);
}

/** All distinct tags present in the full catalog, for building filter chips. */
function allTags() {
  if (typeof beatBank === 'undefined') return [];
  const set = new Set();
  beatBank.forEach((item) => (item.tags || []).forEach((t) => set.add(t.toLowerCase())));
  return [...set].sort();
}

window.beatFilters = {
  apply: applyFilters,
  allTags,
  get active() {
    const c = window.filterCriteria;
    return c.tags.size > 0 || c.free !== 'all'
      || c.bpmMin != null || c.bpmMax != null
      || c.priceMin != null || c.priceMax != null;
  },
  reset() {
    window.filterCriteria = { tags: new Set(), free: 'all', bpmMin: null, bpmMax: null, priceMin: null, priceMax: null };
    applyFilters();
  },
};

applyFilters();
