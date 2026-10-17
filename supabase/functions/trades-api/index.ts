// trades-api — REST surface over trades-repo.js's trade-offer logic
//
// Same identity pattern as download-master: the caller's JWT is forwarded
// into a Supabase client scoped to them, so every RLS policy and the
// accept_trade_offer() Postgres function see the real auth.uid() — this
// function does no authorization itself, it only translates HTTP <-> the
// same Supabase calls trades-repo.js already makes from the browser.
//
// Routes (path is relative to the function's own base URL):
//   POST /            propose a trade offer
//   GET  /            list offers you're party to (?box=incoming|outgoing, ?status=pending)
//   POST /:id/accept  accept an offer and settle the swap atomically
//
// Deploy:
//   supabase functions deploy trades-api

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Sign in to trade.' }, 401);
    }

    // One client, scoped to the caller — every call made with it is subject
    // to RLS as if the real user made it directly, same as trades-repo.js.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: auth } = await userClient.auth.getUser();
    if (!auth?.user) return json({ error: 'Sign in to trade.' }, 401);

    const url = new URL(req.url);
    // Supabase invokes functions at .../functions/v1/trades-api, so strip
    // that prefix if present — locally (via `supabase functions serve`) the
    // path already arrives bare.
    const path = url.pathname.replace(/^\/trades-api/, '') || '/';
    const segments = path.split('/').filter(Boolean); // e.g. ['abc-123', 'accept']

    if (req.method === 'POST' && segments.length === 0) {
      return await handlePropose(req, userClient);
    }

    if (req.method === 'GET' && segments.length === 0) {
      return await handleList(url, userClient);
    }

    if (req.method === 'POST' && segments.length === 2 && segments[1] === 'accept') {
      return await handleAccept(segments[0], userClient);
    }

    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

const LICENSE_KINDS = ['lease', 'premium', 'exclusive'];

function toCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

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

// deno-lint-ignore no-explicit-any
async function handlePropose(req: Request, userClient: any) {
  const user = (await userClient.auth.getUser()).data.user;
  const body = await req.json();
  const {
    offeredBeatId, wantedBeatId,
    offeredKind = 'exclusive', wantedKind = 'exclusive',
    offeredValue = null, wantedValue = null,
    message,
  } = body;

  if (!offeredBeatId || !wantedBeatId) {
    return json({ error: 'offeredBeatId and wantedBeatId are required.' }, 400);
  }
  if (!LICENSE_KINDS.includes(offeredKind)) {
    return json({ error: `offeredKind must be one of: ${LICENSE_KINDS.join(', ')}.` }, 400);
  }
  if (!LICENSE_KINDS.includes(wantedKind)) {
    return json({ error: `wantedKind must be one of: ${LICENSE_KINDS.join(', ')}.` }, 400);
  }

  const { data: wanted, error: wantedError } = await userClient
    .from('beats')
    .select('id, rights_holder_id, status')
    .eq('id', wantedBeatId)
    .single();

  if (wantedError || !wanted) return json({ error: 'That beat could not be found.' }, 404);
  if (wanted.rights_holder_id === user.id) {
    return json({ error: 'You already hold the rights to that beat.' }, 409);
  }
  if (wanted.status === 'sold_exclusive') {
    return json({ error: 'That beat has been sold exclusively and cannot be traded.' }, 409);
  }

  const { data, error } = await userClient
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
    if (error.code === '23505') {
      return json({ error: 'You already have an open offer for this swap.' }, 409);
    }
    return json({ error: `Could not send offer: ${error.message}` }, 500);
  }

  return json(data, 201);
}

// deno-lint-ignore no-explicit-any
async function handleList(url: URL, userClient: any) {
  const user = (await userClient.auth.getUser()).data.user;
  const box = url.searchParams.get('box') === 'outgoing' ? 'outgoing' : 'incoming';
  const status = url.searchParams.get('status') ?? 'pending';

  let query = userClient
    .from('trade_offers')
    .select(OFFER_SELECT)
    .order('created_at', { ascending: false });

  query = box === 'outgoing'
    ? query.eq('proposer_id', user.id)
    : query.eq('recipient_id', user.id);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return json({ error: `Could not load offers: ${error.message}` }, 500);

  return json(data ?? []);
}

// deno-lint-ignore no-explicit-any
async function handleAccept(offerId: string, userClient: any) {
  const { data, error } = await userClient.rpc('accept_trade_offer', {
    offer_id: offerId,
  });

  if (error) {
    // The function raises human-readable messages prefixed with a Postgres
    // error class, e.g. "P0001: This offer is no longer open." — strip that.
    const message = error.message.replace(/^.*?:\s*/, '');
    // Anything the trigger function itself rejected is a client-side
    // conflict (wrong state, wrong person), not a server failure.
    return json({ error: message }, 409);
  }

  return json(data);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
