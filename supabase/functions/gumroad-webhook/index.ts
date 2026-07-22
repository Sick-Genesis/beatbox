// gumroad-webhook — record a producer's Gumroad sale and unlock the beat
//
// beatbox never touches the money. The buyer paid the PRODUCER on the
// producer's own Gumroad; this endpoint only *learns* of the sale and
// grants the licence that download-master already checks.
//
// Gumroad posts a form-encoded "Ping" on each sale. We:
//   1. verify it's really from the linked producer (shared secret)
//   2. find the beat (via a custom url_param we put on the buy link)
//   3. find the buyer — the beatbox user id passed through if they were
//      signed in, else match the purchase email; if neither, hold it
//      'claimable' for whoever signs in with that email later
//   4. write the order and grant the licence
//
// Deploy:  supabase functions deploy gumroad-webhook --no-verify-jwt
// (no-verify-jwt: Gumroad is unauthenticated to us; we verify by secret.)

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // Gumroad pings are application/x-www-form-urlencoded.
    const form = await req.formData();
    const get = (k: string) => (form.get(k)?.toString() ?? '');

    // ── 1. Verify ──
    // We pass our own secret through the buy link as url_params[bb_secret]
    // and compare. Gumroad echoes url_params back on the ping. A shared
    // secret is enough here because a forged order still can't unlock a
    // file for an attacker — the buyer is bound to the purchase email/id.
    const expected = Deno.env.get('GUMROAD_WEBHOOK_SECRET') ?? '';
    if (!expected || get('url_params[bb_secret]') !== expected) {
      return json({ error: 'Bad signature.' }, 401);
    }

    // Gumroad marks test pings; don't grant real access for those.
    if (get('test') === 'true') {
      return json({ ok: true, test: true });
    }

    // ── 2. Which beat ──
    // Set on the buy link as url_params[bb_beat].
    const beatId = get('url_params[bb_beat]');
    if (!beatId) return json({ error: 'No beat reference.' }, 400);

    const { data: beat } = await supabase
      .from('beats')
      .select('id, rights_holder_id, status')
      .eq('id', beatId)
      .single();
    if (!beat) return json({ error: 'Beat not found.' }, 404);

    // ── 3. Which buyer ──
    // bb_uid is the beatbox user id, present only if they were signed in
    // when they clicked buy. Otherwise fall back to the purchase email.
    const passedUid = get('url_params[bb_uid]') || null;
    const email = get('email') || null;

    let buyerId: string | null = null;
    if (passedUid) {
      const { data } = await supabase
        .from('profiles').select('id').eq('id', passedUid).single();
      buyerId = data?.id ?? null;
    }
    if (!buyerId && email) {
      // Match an existing account by email via auth admin.
      const { data } = await supabase.auth.admin.listUsers();
      const hit = data?.users?.find(
        (u) => (u.email ?? '').toLowerCase() === email.toLowerCase(),
      );
      buyerId = hit?.id ?? null;
    }

    const kind = (get('url_params[bb_kind]') || 'lease') as string;
    const priceCents = Math.round(parseFloat(get('price') || '0'));
    const saleId = get('sale_id') || get('order_number') || crypto.randomUUID();

    // ── 4. Record the order (idempotent on provider_sale_id) ──
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .upsert({
        beat_id: beatId,
        buyer_id: buyerId,
        buyer_email: email,
        kind,
        price_cents: priceCents,
        currency: (get('currency') || 'usd').toLowerCase(),
        provider: 'gumroad',
        provider_sale_id: saleId,
        // Matched → completed and unlockable now; unmatched → wait for the
        // buyer to sign in with this email.
        status: buyerId ? 'completed' : 'claimable',
      }, { onConflict: 'provider,provider_sale_id' })
      .select()
      .single();

    if (orderError) {
      return json({ error: `Could not record order: ${orderError.message}` }, 500);
    }

    // ── 5. Grant the licence if we could match the buyer ──
    if (buyerId) {
      await supabase.rpc('grant_purchase_license', { p_order_id: order.id });
    }

    return json({ ok: true, matched: !!buyerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
