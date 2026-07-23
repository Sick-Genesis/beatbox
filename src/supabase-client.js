// supabase-client.js
//
// Single shared Supabase client. Everything that talks to the backend
// imports from here so there is one place to change config or swap
// providers later.
//
// Both env values are public by design — the anon key grants only what the
// row-level security policies in supabase/schema.sql allow. Secrets that
// must stay secret (service role key, Stripe secret) never appear in
// browser code at all.

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Demo mode: a self-contained portfolio build with no backend. When on, the
// app seeds hardcoded data and routes every read/write through an in-memory
// store (see src/demo/), so a visitor lands inside the app as a signed-in
// producer. Turned on by building with VITE_DEMO=true; `npm run dev` stays
// on the real backend.
export const isDemo = import.meta.env.VITE_DEMO === 'true';

// Missing config is the single most likely first-run failure, and the
// default supabase-js error for it is opaque. Fail loudly instead.
//
// In demo mode there is no real Supabase, yet the app must behave as if
// configured — the demo store answers in Supabase's place. So isConfigured
// is true either way, and callers that need the real client still guard on
// `supabase` being non-null (or on !isDemo).
export const isConfigured = isDemo || Boolean(url && anonKey);

if (!isConfigured) {
  console.warn(
    '[beatbox] Supabase is not configured — running on placeholder data.\n' +
    'Copy .env.example to .env.local and fill in VITE_SUPABASE_URL and ' +
    'VITE_SUPABASE_ANON_KEY, then restart `npm run dev`.'
  );
}

if (isDemo) {
  console.info('[beatbox] Demo mode — running on in-memory data, no backend.');
}

// No real client in demo mode: the demo store stands in for it entirely.
export const supabase = (!isDemo && url && anonKey)
  ? createClient(url, anonKey)
  : null;
