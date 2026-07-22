-- beatbox — purchases via linked producer payouts (Gumroad)
--
-- Run after 010_waveform_peaks.sql. Idempotent.
--
-- The money model, stated plainly because it defines the legal exposure:
--
--   beatbox NEVER touches the money. A buyer pays the PRODUCER directly on
--   the producer's own Gumroad. Gumroad is the merchant of record for that
--   sale — tax and payout are between the producer, Gumroad, and the
--   buyer. beatbox only *learns* that a sale happened (via Gumroad's
--   webhook) and unlocks the clean file it already gates.
--
-- So this migration stores: where a producer's payout link lives, a per
-- beat product link, and a record of purchases we've been told about. It
-- does not store, move, or reconcile any funds.

-- ── 1. Producer payout link ──────────────────────────────────────────────────
--
-- On the profile, since it's per producer. The webhook secret lets the
-- Edge Function verify a ping really came from this producer's Gumroad.

alter table public.profiles
  add column if not exists gumroad_connected boolean not null default false;

alter table public.profiles
  add column if not exists gumroad_seller_id text;

comment on column public.profiles.gumroad_seller_id is
  'The producer''s Gumroad seller id, used to attribute an incoming sale
   webhook to them. Payout happens entirely on Gumroad; beatbox never
   holds funds.';

-- ── 2. Per-beat product link ─────────────────────────────────────────────────
--
-- A paid beat points at the producer's Gumroad product. Null → the beat
-- has no buy link yet, and the UI falls back to "message the producer".

alter table public.beats
  add column if not exists buy_url text;

alter table public.beats
  add column if not exists gumroad_product_id text;

comment on column public.beats.buy_url is
  'The producer''s Gumroad product URL for this beat. Null → not buyable
   yet; the buy button becomes a message/offer to the producer.';

-- ── 3. Orders ────────────────────────────────────────────────────────────────
--
-- One row per purchase beatbox has been notified of. This is a RECORD of
-- someone else's transaction, not a transaction of ours.
--
-- A purchase may arrive before we can tie it to an account (buyer used a
-- different email, or wasn't signed in). Such orders are held 'claimable'
-- and attach to the account on next sign-in with a matching email.

do $$ begin
  create type order_status as enum ('completed', 'claimable', 'refunded');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.orders (
  id            uuid primary key default uuid_generate_v4(),

  beat_id       uuid not null references public.beats(id) on delete cascade,

  -- Who bought it. buyer_id is filled when we could match an account;
  -- buyer_email always holds what the payment reported, so a 'claimable'
  -- order can be attached later.
  buyer_id      uuid references public.profiles(id) on delete set null,
  buyer_email   text,

  -- Which tier was bought, snapshotted so a later price change doesn't
  -- rewrite history. Mirrors how licences snapshot their terms.
  kind          license_kind not null default 'lease',
  price_cents   integer,
  currency      text default 'usd',

  -- Provider bookkeeping — the id lets us ignore duplicate webhook
  -- deliveries (Gumroad may retry), so a beat is never double-licensed.
  provider          text not null default 'gumroad',
  provider_sale_id  text,

  status        order_status not null default 'completed',
  created_at    timestamptz not null default now(),

  unique (provider, provider_sale_id)
);

create index if not exists orders_buyer_idx on public.orders(buyer_id);
create index if not exists orders_email_idx on public.orders(lower(buyer_email));
create index if not exists orders_beat_idx  on public.orders(beat_id);

alter table public.orders enable row level security;

-- A buyer sees their own orders; a producer sees orders on their beats.
drop policy if exists "buyers and producers read orders" on public.orders;
create policy "buyers and producers read orders"
  on public.orders for select
  using (
    auth.uid() = buyer_id
    or exists (
      select 1 from public.beats b
      where b.id = orders.beat_id and b.rights_holder_id = auth.uid()
    )
  );

-- No client insert/update: only the webhook (service role) writes orders.
-- That's what stops someone forging a purchase to unlock a file.

-- ── 4. Turn a completed order into a licence ─────────────────────────────────
--
-- The licence is what download-master checks. Keeping order → licence in
-- one place means "what a purchase grants" is defined once.

create or replace function public.grant_purchase_license(p_order_id uuid)
returns public.licenses
language plpgsql
security definer set search_path = public
as $$
declare
  o      public.orders;
  b      public.beats;
  result public.licenses;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Order not found.'; end if;

  -- Only a matched, completed order grants access. A claimable one waits
  -- for its buyer to sign in.
  if o.buyer_id is null or o.status <> 'completed' then
    return null;
  end if;

  -- Idempotent: if this order already granted a licence, return it.
  select * into result from public.licenses
    where beat_id = o.beat_id and holder_id = o.buyer_id and order_id = o.id
    limit 1;
  if found then return result; end if;

  select * into b from public.beats where id = o.beat_id;

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin, order_id)
  values (
    o.beat_id, o.buyer_id, o.kind,
    coalesce((select deliverable from public.license_tiers t
              where t.beat_id = o.beat_id and t.kind = o.kind limit 1), 'mp3'),
    (select terms from public.license_tiers t
              where t.beat_id = o.beat_id and t.kind = o.kind limit 1),
    'purchase', o.id
  )
  returning * into result;

  -- An exclusive purchase withdraws the beat from sale, same as elsewhere.
  if o.kind = 'exclusive' then
    update public.beats set status = 'sold_exclusive' where id = o.beat_id;
  end if;

  return result;
end;
$$;

-- ── 5. Claim orders waiting on an email, at sign-in ──────────────────────────
--
-- Called by the client after login: attaches any 'claimable' orders whose
-- email matches this account, then grants their licences. This is the
-- "bought with a different email / while signed out" recovery path.

create or replace function public.claim_pending_orders()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  mail  text;
  o     public.orders;
  n     integer := 0;
begin
  if me is null then return 0; end if;

  select email into mail from auth.users where id = me;
  if mail is null then return 0; end if;

  for o in
    select * from public.orders
     where status = 'claimable'
       and buyer_id is null
       and lower(buyer_email) = lower(mail)
  loop
    update public.orders
       set buyer_id = me, status = 'completed'
     where id = o.id;
    perform public.grant_purchase_license(o.id);
    n := n + 1;
  end loop;

  return n;
end;
$$;
