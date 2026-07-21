-- beatbox — barter for leases (and mixed-kind trades)
--
-- Run after 002_trades.sql. Idempotent.
--
-- 002 assumed every trade was an exclusive swap: move rights_holder_id,
-- mark both beats 'traded', done. That assumption breaks for leases.
--
-- A lease trade does NOT move ownership and does NOT take the beat off the
-- market. The producer keeps the beat and keeps selling it; they have
-- simply granted one more non-exclusive license, and so has the other side.
-- So a lease trade is not a swap of beat rows at all — it is the MUTUAL
-- ISSUANCE OF TWO LICENSES.
--
-- That requires a licenses table, which is also what a cash purchase will
-- eventually write to. Trading pulls it forward.

-- ── 1. Licenses (granted rights) ─────────────────────────────────────────────
--
-- One row per license actually held by someone. Distinct from
-- license_tiers, which is the PRICE LIST; this is the LEDGER of what has
-- been granted, by any means.

do $$ begin
  create type license_origin as enum ('purchase', 'trade');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.licenses (
  id           uuid primary key default uuid_generate_v4(),

  beat_id      uuid not null references public.beats(id) on delete cascade,
  holder_id    uuid not null references public.profiles(id) on delete cascade,

  -- Snapshot of what was granted. Copied from the beat's license_tier at
  -- grant time rather than referenced, so later price or wording changes
  -- never retroactively alter a license someone already holds.
  kind         license_kind not null,
  deliverable  text not null default 'mp3',
  terms        text,

  origin       license_origin not null,
  trade_id     uuid,           -- set when origin = 'trade'
  order_id     uuid,           -- set when origin = 'purchase' (table TBD)

  granted_at   timestamptz not null default now()
  -- "At most one exclusive per beat" is enforced by the partial unique
  -- index below, not by a check constraint — a check can't see other rows.
);

create index if not exists licenses_beat_idx   on public.licenses(beat_id);
create index if not exists licenses_holder_idx on public.licenses(holder_id);

-- The hard guarantee: at most one exclusive per beat, at the database
-- level, regardless of what any application code does.
create unique index if not exists licenses_one_exclusive_per_beat
  on public.licenses(beat_id)
  where kind = 'exclusive';

comment on table public.licenses is
  'Ledger of granted rights. license_tiers is the price list; this is what
   has actually been handed over, by purchase or by trade.';

alter table public.licenses enable row level security;

-- Holders see their own licenses; rights holders see everything granted
-- on their beats (they need to know who holds what).
drop policy if exists "holders and beat owners read licenses" on public.licenses;
create policy "holders and beat owners read licenses"
  on public.licenses for select
  using (
    auth.uid() = holder_id
    or exists (
      select 1 from public.beats b
      where b.id = licenses.beat_id and b.rights_holder_id = auth.uid()
    )
  );

-- No insert/update/delete policy: only security-definer functions write
-- here. Licenses are never edited or revoked by client code.

-- ── 2. Offers carry a license kind per side ──────────────────────────────────
--
-- Each side independently states what it is granting, so mixed trades
-- (my exclusive for your lease) are expressible. Fairness is settled in
-- the negotiation, not constrained by the schema.

alter table public.trade_offers
  add column if not exists offered_kind license_kind not null default 'exclusive';

alter table public.trade_offers
  add column if not exists wanted_kind  license_kind not null default 'exclusive';

comment on column public.trade_offers.offered_kind is
  'What the proposer grants on their beat.';
comment on column public.trade_offers.wanted_kind is
  'What the recipient grants on theirs.';

-- Same on the settled ledger, so history records what was actually swapped.
alter table public.trades
  add column if not exists beat_a_kind license_kind not null default 'exclusive';
alter table public.trades
  add column if not exists beat_b_kind license_kind not null default 'exclusive';

-- ── 3. Helper: resolve the terms for a kind on a beat ────────────────────────
--
-- Traded licenses carry the SAME terms as a bought one, so there is a
-- single definition of what e.g. "a lease on this beat" means. Falls back
-- to sane defaults when the producer hasn't defined that tier.

create or replace function public.resolve_tier_terms(
  p_beat_id uuid,
  p_kind    license_kind,
  out o_deliverable text,
  out o_terms       text
)
language plpgsql
stable
as $$
begin
  select lt.deliverable, lt.terms
    into o_deliverable, o_terms
    from public.license_tiers lt
   where lt.beat_id = p_beat_id and lt.kind = p_kind
   limit 1;

  if o_deliverable is null then
    o_deliverable := case p_kind
      when 'exclusive' then 'stems'
      when 'premium'   then 'wav'
      else 'mp3'
    end;
  end if;
end;
$$;

-- ── 4. Settlement, rewritten for both kinds ──────────────────────────────────
--
-- Replaces the 002 version. Same locking discipline; the difference is
-- that what happens to each beat now depends on the kind being granted:
--
--   exclusive  → rights_holder_id moves, beat leaves the market ('traded')
--   lease /    → nothing about the beat changes; a license row is issued
--   premium      and the beat stays published and sellable
--
-- Each side is evaluated independently, so a mixed trade does the right
-- thing on each half.

create or replace function public.accept_trade_offer(offer_id uuid)
returns public.trades
language plpgsql
security definer set search_path = public
as $$
declare
  o            public.trade_offers;
  beat_offered public.beats;
  beat_wanted  public.beats;
  result       public.trades;
  v_deliverable text;
  v_terms       text;
begin
  select * into o from public.trade_offers where id = offer_id for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if o.status <> 'pending' then
    raise exception 'This offer is no longer open (status: %).', o.status;
  end if;

  if o.recipient_id <> auth.uid() then
    raise exception 'Only the person who received this offer can accept it.';
  end if;

  -- Lock both beats in a stable order to avoid deadlocking against a
  -- simultaneous trade on the same pair.
  if o.offered_beat_id < o.wanted_beat_id then
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
  else
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
  end if;

  -- Re-verify control AFTER locking: either beat may have moved since the
  -- offer was made.
  if beat_offered.rights_holder_id <> o.proposer_id then
    update public.trade_offers
      set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'The offered beat no longer belongs to the person who proposed this trade.';
  end if;

  if beat_wanted.rights_holder_id <> o.recipient_id then
    update public.trade_offers
      set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'You no longer hold the rights to the beat being requested.';
  end if;

  -- A beat whose exclusive is already gone cannot grant anything further —
  -- not another exclusive, and not a lease either, since the exclusive
  -- holder now controls it.
  if beat_offered.status = 'sold_exclusive' then
    raise exception 'The offered beat has already been sold exclusively.';
  end if;
  if beat_wanted.status = 'sold_exclusive' then
    raise exception 'Your beat has already been sold exclusively.';
  end if;

  -- ── Side A: what the proposer grants to the recipient ──
  select o_deliverable, o_terms into v_deliverable, v_terms
    from public.resolve_tier_terms(o.offered_beat_id, o.offered_kind);

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin)
  values
    (o.offered_beat_id, o.recipient_id, o.offered_kind, v_deliverable, v_terms, 'trade');

  if o.offered_kind = 'exclusive' then
    update public.beats
      set rights_holder_id = o.recipient_id,
          status = 'traded'
      where id = o.offered_beat_id;
  end if;
  -- lease / premium: the beat is untouched and stays on sale.

  -- ── Side B: what the recipient grants to the proposer ──
  select o_deliverable, o_terms into v_deliverable, v_terms
    from public.resolve_tier_terms(o.wanted_beat_id, o.wanted_kind);

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin)
  values
    (o.wanted_beat_id, o.proposer_id, o.wanted_kind, v_deliverable, v_terms, 'trade');

  if o.wanted_kind = 'exclusive' then
    update public.beats
      set rights_holder_id = o.proposer_id,
          status = 'traded'
      where id = o.wanted_beat_id;
  end if;

  update public.trade_offers
    set status = 'accepted', resolved_at = now()
    where id = o.id;

  -- Only an EXCLUSIVE grant invalidates other pending offers, because only
  -- it removes the beat from the market. Lease trades leave every other
  -- open negotiation perfectly valid.
  if o.offered_kind = 'exclusive' or o.wanted_kind = 'exclusive' then
    update public.trade_offers
      set status = 'cancelled', resolved_at = now()
      where status = 'pending'
        and id <> o.id
        and (
          (o.offered_kind = 'exclusive' and
             (offered_beat_id = o.offered_beat_id or wanted_beat_id = o.offered_beat_id))
          or
          (o.wanted_kind = 'exclusive' and
             (offered_beat_id = o.wanted_beat_id or wanted_beat_id = o.wanted_beat_id))
        );
  end if;

  insert into public.trades
    (offer_id, party_a_id, beat_a_id, beat_a_kind,
                party_b_id, beat_b_id, beat_b_kind)
  values
    (o.id, o.proposer_id, o.offered_beat_id, o.offered_kind,
           o.recipient_id, o.wanted_beat_id, o.wanted_kind)
  returning * into result;

  return result;
end;
$$;

-- ── 5. Offer insert policy allows non-exclusive beats ────────────────────────
--
-- 002 required the beat merely to exist and not be sold_exclusive. That
-- still holds, but a beat already 'traded' away can now legitimately be
-- offered again by its NEW rights holder — the policy keys on
-- rights_holder_id, so this already works. Restated for clarity.

drop policy if exists "propose trades with own beats" on public.trade_offers;
create policy "propose trades with own beats"
  on public.trade_offers for insert
  with check (
    auth.uid() = proposer_id
    and exists (
      select 1 from public.beats b
      where b.id = offered_beat_id
        and b.rights_holder_id = auth.uid()
        and b.status <> 'sold_exclusive'
    )
    and exists (
      select 1 from public.beats b
      where b.id = wanted_beat_id
        and b.rights_holder_id = recipient_id
        and b.status <> 'sold_exclusive'
    )
  );

-- The pending-offer uniqueness index from 002 keyed only on the beat pair.
-- With kinds in play, the same pair at different kinds is a genuinely
-- different proposal, so it must be part of the key.
drop index if exists trade_offers_one_pending;
create unique index if not exists trade_offers_one_pending
  on public.trade_offers(proposer_id, offered_beat_id, wanted_beat_id, offered_kind, wanted_kind)
  where status = 'pending';
