// purchases-repo.js
//
// The buy side. beatbox never handles money — a buyer pays the PRODUCER on
// the producer's Gumroad, and the gumroad-webhook Edge Function unlocks the
// beat afterwards. This module only builds the outgoing buy link (with the
// params the webhook reads back) and reconciles purchases on our side.

import { supabase, isConfigured } from './supabase-client.js';
import { getSession } from './auth.js';

/**
 * Build the URL to send a buyer to, from a beat's Gumroad buy_url.
 *
 * We append url_params that Gumroad echoes back on the sale ping, so the
 * webhook can tie the payment to the right beat, buyer and tier:
 *   bb_beat   — which beat
 *   bb_kind   — which licence tier
 *   bb_uid    — the buyer's beatbox id, IF signed in (exact match); the
 *               webhook falls back to the purchase email otherwise
 *   bb_secret — shared secret so the webhook can trust the ping
 *
 * bb_secret is public-ish (it rides in a URL), but a forged ping still
 * can't unlock a file for an attacker: access is bound to the purchase
 * email/id, not to knowing the secret. It only stops random spam pings.
 */
export async function buildBuyUrl(beat, { kind = 'lease' } = {}) {
  if (!beat?.buyUrl) return null;

  const url = new URL(beat.buyUrl);
  url.searchParams.set('url_params[bb_beat]', beat.id);
  url.searchParams.set('url_params[bb_kind]', kind);
  url.searchParams.set('url_params[bb_secret]', import.meta.env.VITE_GUMROAD_LINK_SECRET ?? '');

  const session = await getSession();
  if (session?.id) {
    url.searchParams.set('url_params[bb_uid]', session.id);
    // Prefill Gumroad's email field so the fallback match works even if
    // they don't reach the signed-in path.
    if (session.email) url.searchParams.set('email', session.email);
  }

  return url.toString();
}

/**
 * Reconcile purchases made while signed out or with a different email.
 * Call after sign-in. Returns how many orders were attached.
 */
export async function claimPendingOrders() {
  if (!isConfigured) return 0;
  const { data, error } = await supabase.rpc('claim_pending_orders');
  if (error) {
    console.warn('[beatbox] Could not claim pending orders:', error.message);
    return 0;
  }
  return data ?? 0;
}

/** Beats the signed-in user has bought. */
export async function listPurchases() {
  if (!isConfigured) return [];
  const session = await getSession();
  if (!session) return [];

  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, kind, price_cents, currency, status, created_at,
      beat:beat_id ( id, title, artist )
    `)
    .eq('buyer_id', session.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[beatbox] Could not load purchases:', error.message);
    return [];
  }
  return data ?? [];
}

/** Has the signed-in user already bought (or been granted) this beat? */
export async function ownsBeat(beatId) {
  if (!isConfigured) return false;
  const session = await getSession();
  if (!session) return false;

  const { data, error } = await supabase
    .from('licenses')
    .select('id')
    .eq('beat_id', beatId)
    .eq('holder_id', session.id)
    .limit(1);

  if (error) return false;   // treat an error as "not owned", never throw
  return (data?.length ?? 0) > 0;
}
