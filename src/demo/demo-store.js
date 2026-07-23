// demo-store.js
//
// The in-memory backend for the demo build. It exposes the same functions
// the real repos do (fetchBeats, getSession, listPurchases, createBeat, …)
// but answers from cloned seed data instead of Supabase. main.js and the
// repos route to these when isDemo is true, so the UI is unchanged.
//
// State lives for the life of the page: a visitor can upload a beat, buy one,
// or claim a free one and see it stick — until they refresh, which reloads
// the pristine seed. That reset is deliberate; it keeps the demo clean for
// the next visitor with zero persistence to manage.

import {
  DEMO_USER, DEMO_BEATS, DEMO_PURCHASES, DEMO_OWNED_BEAT_IDS, DEMO_OFFERS,
  expandBeat,
} from './demo-data.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Mutable session state, seeded from the pristine data ─────────────────────

const state = {
  beats: DEMO_BEATS.map((b) => expandBeat(b)),
  purchases: clone(DEMO_PURCHASES),
  ownedBeatIds: new Set(DEMO_OWNED_BEAT_IDS),
  offers: clone(DEMO_OFFERS),
};

// Simple pub/sub so the auth bar can reflect the (always signed-in) session.
const listeners = new Set();
function emit() {
  const s = getSessionSync();
  listeners.forEach((fn) => { try { fn(s); } catch (e) { console.error(e); } });
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export function getSessionSync() {
  return { ...DEMO_USER };
}
export async function getSession() {
  return getSessionSync();
}
export async function currentUser() {
  return { id: DEMO_USER.id, email: DEMO_USER.email };
}
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export async function signOut() {
  // Signing out of a demo would strand the visitor on an empty logged-out
  // shell with no way back in. Keep them signed in; the button says so.
  demoToast("This is a demo — you stay signed in as @sila.");
}

// ── Beats ────────────────────────────────────────────────────────────────────

export async function fetchBeats() {
  return state.beats.map((b) => clone(b));
}

export async function ownsBeat(beatId) {
  return state.ownedBeatIds.has(beatId);
}

export async function claimFreeBeat(beatId) {
  state.ownedBeatIds.add(beatId);
  demoToast('Added to your library.');
  return { ok: true };
}

export async function getMasterDownloadUrl(beatId) {
  // No real signed URL in the demo — hand back the playable loop so the
  // Download button does something visible instead of erroring.
  const beat = state.beats.find((b) => b.id === beatId);
  demoToast('In the real app this is a signed, one-time download link.');
  return beat?.audioUrl ?? null;
}

// A newly uploaded beat, built from the upload form's fields, prepended so it
// appears at the front of the catalog like the real newest-first order.
export async function createBeat(input = {}) {
  const id = `beat-demo-${Date.now()}`;
  const entry = {
    id,
    title: input.title?.trim() || 'untitled',
    artist: input.artist?.trim() || DEMO_USER.displayName,
    artwork: null,
    // Play the uploaded file back if we can make an object URL for it;
    // otherwise fall back to a demo loop so the beat is still audible.
    audioUrl: fileUrl(input.audioFile) || state.beats[0]?.audioUrl || null,
    bank: DEMO_USER.id,
    file: id,
    previewState: 'ready',
    previewMode: input.previewMode || 'platform',
    isFree: !!input.isFree,
    freeTerms: input.isFree ? 'Free — use in any capacity.' : null,
    buyUrl: input.isFree ? null : `demo://buy/${id}`,
    peaks: null, // transport draws a flat bar until playback measures it
    bpm: input.bpm ? Number(input.bpm) : null,
    musicalKey: input.musicalKey?.trim() || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    producerId: DEMO_USER.id,
    rightsHolderId: DEMO_USER.id,
    status: 'published',
    withdrawnAt: null,
    containsSamples: !!input.containsSamples,
    tradable: !input.isFree,
    licenses: (input.licenses || []).map((l, i) => ({
      id: `${id}-t${i}`,
      kind: l.kind,
      price_cents: Math.round(Number(l.price) * 100),
      currency: 'usd',
      deliverable: l.deliverable || 'mp3',
      terms: l.terms || null,
    })),
  };
  state.beats.unshift(entry);
  return clone(entry);
}

function fileUrl(file) {
  try {
    if (file instanceof File || file instanceof Blob) return URL.createObjectURL(file);
  } catch { /* not in a browser context */ }
  return null;
}

// ── Purchases ────────────────────────────────────────────────────────────────

export async function listPurchases() {
  return clone(state.purchases);
}

export async function claimPendingOrders() {
  return 0; // nothing pending in the demo
}

// The real buildBuyUrl returns a Gumroad URL to open. In the demo we never
// send a visitor to a real checkout — main.js detects the demo scheme and
// shows a mock checkout instead. Returning the sentinel is enough.
export async function buildBuyUrl(beat) {
  return beat?.buyUrl ?? null;
}

// Called by the mock checkout once a visitor "completes" a demo purchase.
export function completeDemoPurchase(beat, kind = 'lease') {
  const tier = (beat.licenses || []).find((t) => t.kind === kind) || beat.licenses?.[0];
  state.ownedBeatIds.add(beat.id);
  state.purchases.unshift({
    id: `order-demo-${Date.now()}`,
    kind: tier?.kind || 'lease',
    price_cents: tier?.price_cents ?? 0,
    currency: 'usd',
    status: 'completed',
    created_at: new Date().toISOString(),
    beat: { id: beat.id, title: beat.title, artist: beat.artist },
  });
}

// ── Trades ───────────────────────────────────────────────────────────────────

export async function listOffers({ box = 'incoming', status = 'pending' } = {}) {
  return clone(state.offers.filter((o) => {
    const boxMatch = box === 'outgoing'
      ? o.proposer_id === DEMO_USER.id
      : o.recipient_id === DEMO_USER.id;
    const statusMatch = !status || o.status === status;
    return boxMatch && statusMatch;
  }));
}

export async function pendingOfferCount() {
  return state.offers.filter(
    (o) => o.recipient_id === DEMO_USER.id && o.status === 'pending',
  ).length;
}

export async function acceptTrade(offerId) {
  const o = state.offers.find((x) => x.id === offerId);
  if (o) o.status = 'accepted';
  demoToast('Trade accepted — both beats swapped.');
  return { ok: true };
}
export async function declineTrade(offerId) {
  const o = state.offers.find((x) => x.id === offerId);
  if (o) o.status = 'declined';
  return { ok: true };
}

// ── Demo toast ───────────────────────────────────────────────────────────────
//
// A small, self-contained notice for demo-only moments (buy, download,
// sign-out). Kept here so the store can speak without importing UI modules.

let toastTimer = null;
export function demoToast(message) {
  if (typeof document === 'undefined') return;
  document.getElementById('demo-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'demo-toast';
  el.className = 'demo-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4200);
}
