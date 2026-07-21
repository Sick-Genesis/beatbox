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

// Missing config is the single most likely first-run failure, and the
// default supabase-js error for it is opaque. Fail loudly instead.
export const isConfigured = Boolean(url && anonKey);

if (!isConfigured) {
  console.warn(
    '[beatbox] Supabase is not configured — running on placeholder data.\n' +
    'Copy .env.example to .env.local and fill in VITE_SUPABASE_URL and ' +
    'VITE_SUPABASE_ANON_KEY, then restart `npm run dev`.'
  );
}

export const supabase = isConfigured
  ? createClient(url, anonKey)
  : null;
