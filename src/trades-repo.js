// trades-repo.js
//
// Direct trade (barter): two producers swap exclusive rights to one beat
// each, with no money involved.
//
// The negotiation is the feature. Because barter has no common unit, "is
// this a fair swap" can't be settled by price — it's settled by an offer,
// optional counter-offers, and an acceptance. That chain is the product.
//
// Settlement deliberately does NOT happen here. Accepting calls the
// accept_trade_offer() Postgres function, which locks both beat rows and
// swaps them in a single transaction. Doing it client-side would open a
// window where two people accept offers on the same beat and one of them
// hands over a beat for nothing.

import { supabase, isConfigured } from './supabase-client.js';

/** Fields needed to render an offer card, for both beats and both parties. */
const OFFER_SELECT = `
  id, message, status, created_at, resolved_at, counter_of_id,
  proposer_id, recipient_id,
  offered_kind, wanted_kind,
  offered_declared_value_cents, wanted_declared_value_cents,
  offered_beat:offered_beat_id (
    id, title, artist, artwork_path, bpm, musical_key, producer_id, rights_holder_id
  ),
  wanted_beat:wanted_beat_id (
    id, title, artist, artwork_path, bpm, musical_key, producer_id, rights_holder_id
  )
`;

function requireConfig() {
  if (!isConfigured) throw new Error('Supabase is not configured.');
}

async function requireUser() {
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) throw new Error('You need to be signed in to trade.');
  return user;
}

/** Valid license kinds, in ascending order of what they grant. */
export const LICENSE_KINDS = ['lease', 'premium', 'exclusive'];

function assertKind(kind, label) {
  if (!LICENSE_KINDS.includes(kind)) {
    throw new Error(`${label} must be one of: ${LICENSE_KINDS.join(', ')}.`);
  }
}

/**
 * Declared values are what the PARTIES say a side is worth, for their own
 * tax reporting — barter is taxable in most places even though no money
 * moves. beatbox records the declaration; it does not value anything.
 * Keep that distinction in any UI wording.
 */
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Propose a swap: `offeredKind` on your beat for `wantedKind` on theirs.
 *
 * Each side names what it grants, so mixed trades (my exclusive for your
 * lease) are expressible. Only an exclusive grant moves ownership and
 * withdraws a beat from sale — a lease trade leaves both beats on the
 * market, having simply issued one more non-exclusive license each way.
 *
 * The recipient is derived from the wanted beat's current rights holder
 * rather than passed in, so an offer can't be misaddressed.
 */
export async function proposeTrade({
  offeredBeatId,
  wantedBeatId,
  offeredKind = 'exclusive',
  wantedKind = 'exclusive',
  offeredValue = null,
  wantedValue = null,
  message,
}) {
  assertKind(offeredKind, 'What you offer');
  assertKind(wantedKind, 'What you request');

  requireConfig();
  const user = await requireUser();

  const { data: wanted, error: wantedError } = await supabase
    .from('beats')
    .select('id, rights_holder_id, status')
    .eq('id', wantedBeatId)
    .single();

  if (wantedError || !wanted) throw new Error('That beat could not be found.');
  if (wanted.rights_holder_id === user.id) {
    throw new Error('You already hold the rights to that beat.');
  }
  if (wanted.status === 'sold_exclusive') {
    throw new Error('That beat has been sold exclusively and cannot be traded.');
  }

  const { data, error } = await supabase
    .from('trade_offers')
    .insert({
      proposer_id: user.id,
      offered_beat_id: offeredBeatId,
      offered_kind: offeredKind,
      recipient_id: wanted.rights_holder_id,
      wanted_beat_id: wantedBeatId,
      wanted_kind: wantedKind,
      offered_declared_value_cents: toCents(offeredValue),
      wanted_declared_value_cents: toCents(wantedValue),
      message: message?.trim() || null,
    })
    .select(OFFER_SELECT)
    .single();

  if (error) {
    // The partial unique index on pending offers surfaces as 23505.
    if (error.code === '23505') {
      throw new Error('You already have an open offer for this swap.');
    }
    throw new Error(`Could not send offer: ${error.message}`);
  }

  return data;
}

/**
 * Counter an offer: propose a different pairing in response.
 * Marks the original 'countered' and links the new offer to it, so the
 * negotiation reads as a chain rather than a mutated row.
 */
export async function counterTrade({
  originalOfferId,
  offeredBeatId,
  wantedBeatId,
  offeredKind = 'exclusive',
  wantedKind = 'exclusive',
  offeredValue = null,
  wantedValue = null,
  message,
}) {
  assertKind(offeredKind, 'What you offer');
  assertKind(wantedKind, 'What you request');

  requireConfig();
  const user = await requireUser();

  const { data: original, error: readError } = await supabase
    .from('trade_offers')
    .select('id, proposer_id, recipient_id, status')
    .eq('id', originalOfferId)
    .single();

  if (readError || !original) throw new Error('That offer could not be found.');
  if (original.status !== 'pending') {
    throw new Error('That offer is no longer open.');
  }
  if (original.recipient_id !== user.id) {
    throw new Error('Only the person who received an offer can counter it.');
  }

  const { data, error } = await supabase
    .from('trade_offers')
    .insert({
      proposer_id: user.id,
      offered_beat_id: offeredBeatId,
      offered_kind: offeredKind,
      recipient_id: original.proposer_id,
      wanted_beat_id: wantedBeatId,
      wanted_kind: wantedKind,
      offered_declared_value_cents: toCents(offeredValue),
      wanted_declared_value_cents: toCents(wantedValue),
      message: message?.trim() || null,
      counter_of_id: originalOfferId,
    })
    .select(OFFER_SELECT)
    .single();

  if (error) throw new Error(`Could not send counter-offer: ${error.message}`);

  await supabase
    .from('trade_offers')
    .update({ status: 'countered', resolved_at: new Date().toISOString() })
    .eq('id', originalOfferId);

  return data;
}

/**
 * Accept an offer and settle the swap atomically.
 * All validation and both ownership changes happen inside Postgres.
 */
export async function acceptTrade(offerId) {
  requireConfig();
  await requireUser();

  const { data, error } = await supabase.rpc('accept_trade_offer', {
    offer_id: offerId,
  });

  if (error) {
    // The function raises human-readable messages; surface them as-is.
    throw new Error(error.message.replace(/^.*?:\s*/, ''));
  }

  return data;
}

export async function declineTrade(offerId) {
  requireConfig();
  await requireUser();

  const { error } = await supabase
    .from('trade_offers')
    .update({ status: 'declined', resolved_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('status', 'pending');

  if (error) throw new Error(`Could not decline: ${error.message}`);
}

/** Withdraw an offer you proposed, before it's answered. */
export async function withdrawTrade(offerId) {
  requireConfig();
  const user = await requireUser();

  const { error } = await supabase
    .from('trade_offers')
    .update({ status: 'withdrawn', resolved_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('proposer_id', user.id)
    .eq('status', 'pending');

  if (error) throw new Error(`Could not withdraw: ${error.message}`);
}

/**
 * Offers involving the signed-in user. RLS already limits rows to those
 * they're party to; `box` splits them into incoming and outgoing.
 */
export async function listOffers({ box = 'incoming', status = 'pending' } = {}) {
  requireConfig();
  const user = await requireUser();

  let query = supabase
    .from('trade_offers')
    .select(OFFER_SELECT)
    .order('created_at', { ascending: false });

  query = box === 'outgoing'
    ? query.eq('proposer_id', user.id)
    : query.eq('recipient_id', user.id);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    console.error('[beatbox] Could not load offers:', error.message);
    return [];
  }
  return data || [];
}

/** Count of pending incoming offers — for the sidebar envelope badge. */
export async function pendingOfferCount() {
  if (!isConfigured) return 0;
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return 0;

  const { count, error } = await supabase
    .from('trade_offers')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', data.user.id)
    .eq('status', 'pending');

  return error ? 0 : (count ?? 0);
}

/** Completed swaps involving the signed-in user. */
export async function listTrades() {
  requireConfig();
  await requireUser();

  const { data, error } = await supabase
    .from('trades')
    .select(`
      id, settled_at, beat_a_kind, beat_b_kind,
      party_a_id, party_b_id,
      beat_a:beat_a_id ( id, title, artist, producer_id ),
      beat_b:beat_b_id ( id, title, artist, producer_id )
    `)
    .order('settled_at', { ascending: false });

  if (error) {
    console.error('[beatbox] Could not load trades:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Licenses the signed-in user holds, however they were acquired.
 *
 * This is what a buyer's library reads from. RLS also lets a rights holder
 * see licenses granted on their own beats, so passing `beatId` answers
 * "who holds rights to this beat" for its owner.
 */
export async function listLicenses({ beatId = null } = {}) {
  requireConfig();
  const user = await requireUser();

  let query = supabase
    .from('licenses')
    .select(`
      id, kind, deliverable, terms, origin, granted_at, holder_id,
      beat:beat_id ( id, title, artist, producer_id, rights_holder_id )
    `)
    .order('granted_at', { ascending: false });

  query = beatId ? query.eq('beat_id', beatId) : query.eq('holder_id', user.id);

  const { data, error } = await query;
  if (error) {
    console.error('[beatbox] Could not load licenses:', error.message);
    return [];
  }
  return data || [];
}
