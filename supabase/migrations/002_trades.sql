-- beatbox — direct trade (barter) mechanism
--
-- Run after schema.sql. Idempotent: safe to re-run.
--
-- What this adds: two producers swap EXCLUSIVE RIGHTS to one beat each.
-- No money changes hands. This is a transaction shape the incumbent
-- platforms don't offer at all, and it needs three things the cash model
-- never did:
--
--   1. Separating who MADE a beat from who currently HOLDS rights to it.
--   2. A negotiation phase — barter has no common unit, so "is this a fair
--      swap" can only be settled by offer/counter/accept, not by price.
--   3. An atomic settlement — two beats change hands at once, and a
--      half-completed trade means someone gave up a beat for nothing.

-- ── 1. Creator vs rights holder ──────────────────────────────────────────────
--
-- producer_id stays put forever: it is the CREATOR CREDIT and never moves.
-- rights_holder_id is who currently controls the beat. They start identical
-- and diverge the first time a beat is traded away.

alter table public.beats
  add column if not exists rights_holder_id uuid references public.profiles(id) on delete set null;

-- Backfill: for every existing beat the creator is also the rights holder.
update public.beats
  set rights_holder_id = producer_id
  where rights_holder_id is null;

alter table public.beats
  alter column rights_holder_id set not null;

create index if not exists beats_rights_holder_idx
  on public.beats(rights_holder_id);

comment on column public.beats.producer_id is
  'Creator credit. Never changes, including after a trade.';
comment on column public.beats.rights_holder_id is
  'Who currently holds exclusive rights and may trade or sell the beat.';

-- 'traded' is distinct from 'sold_exclusive': rights moved, but by barter
-- rather than purchase. Keeping them separate preserves the history of HOW
-- a beat left the market.
--
-- NOTE: `alter type ... add value` cannot run inside a transaction block in
-- Postgres. If your SQL client wraps statements in one, run this single line
-- on its own first, then the rest of the file:
--
--     alter type beat_status add value if not exists 'traded';
--
-- The DO block below is the transaction-safe equivalent and normally makes
-- that unnecessary.
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'beat_status' and e.enumlabel = 'traded'
  ) then
    execute 'alter type beat_status add value ''traded''';
  end if;
end $$;

-- ── 2. Trade offers (the negotiation phase) ──────────────────────────────────

do $$ begin
  create type trade_status as enum (
    'pending',    -- proposed, awaiting a response
    'countered',  -- superseded by a counter-offer
    'accepted',   -- settled; both beats have changed hands
    'declined',
    'withdrawn',  -- pulled by the proposer before a response
    'cancelled'   -- auto-invalidated (e.g. a beat left the market)
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.trade_offers (
  id             uuid primary key default uuid_generate_v4(),

  -- Who proposes, and what they put up.
  proposer_id    uuid not null references public.profiles(id) on delete cascade,
  offered_beat_id uuid not null references public.beats(id) on delete cascade,

  -- Who receives, and what is requested from them.
  recipient_id   uuid not null references public.profiles(id) on delete cascade,
  wanted_beat_id uuid not null references public.beats(id) on delete cascade,

  message        text,
  status         trade_status not null default 'pending',

  -- Counter-offers form a chain rather than mutating the original, so the
  -- whole negotiation stays readable as history.
  counter_of_id  uuid references public.trade_offers(id) on delete set null,

  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,

  -- Trading a beat for itself is meaningless.
  constraint different_beats check (offered_beat_id <> wanted_beat_id),
  constraint different_parties check (proposer_id <> recipient_id)
);

create index if not exists trade_offers_recipient_idx
  on public.trade_offers(recipient_id, status);
create index if not exists trade_offers_proposer_idx
  on public.trade_offers(proposer_id, status);

-- At most one live offer per direction per beat pair, so a producer can't
-- be spammed with duplicates of the same proposal.
create unique index if not exists trade_offers_one_pending
  on public.trade_offers(proposer_id, offered_beat_id, wanted_beat_id)
  where status = 'pending';

-- ── 3. Trade ledger (chain of custody) ───────────────────────────────────────
--
-- Immutable record of every completed swap. Because a rights holder may
-- re-trade a beat, this is what makes provenance reconstructible: who held
-- what, when, and what they gave for it.

create table if not exists public.trades (
  id                uuid primary key default uuid_generate_v4(),
  offer_id          uuid not null references public.trade_offers(id),

  party_a_id        uuid not null references public.profiles(id),
  beat_a_id         uuid not null references public.beats(id),

  party_b_id        uuid not null references public.profiles(id),
  beat_b_id         uuid not null references public.beats(id),

  settled_at        timestamptz not null default now()
);

create index if not exists trades_party_a_idx on public.trades(party_a_id);
create index if not exists trades_party_b_idx on public.trades(party_b_id);

-- ── 4. Atomic settlement ─────────────────────────────────────────────────────
--
-- The critical function. Everything here happens in one transaction, with
-- both beat rows locked before anything is checked, so two people accepting
-- offers on the same beat at the same moment cannot both succeed.
--
-- Called by the recipient of an offer. security definer so it can update
-- beats the caller does not currently own — the ownership checks below are
-- what keep that safe, so they must be exhaustive.

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
begin
  select * into o from public.trade_offers where id = offer_id for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if o.status <> 'pending' then
    raise exception 'This offer is no longer open (status: %).', o.status;
  end if;

  -- Only the recipient may accept.
  if o.recipient_id <> auth.uid() then
    raise exception 'Only the person who received this offer can accept it.';
  end if;

  -- Lock both beats in a stable order. Locking by sorted id prevents the
  -- classic deadlock where two simultaneous trades grab the same pair of
  -- rows in opposite orders.
  if o.offered_beat_id < o.wanted_beat_id then
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
  else
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
  end if;

  -- Re-verify ownership AFTER locking. Between the offer being made and
  -- accepted, either beat may have been traded away by someone else.
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

  -- A beat already gone from the market cannot be traded again.
  if beat_offered.status in ('sold_exclusive') then
    raise exception 'The offered beat has already been sold exclusively.';
  end if;
  if beat_wanted.status in ('sold_exclusive') then
    raise exception 'Your beat has already been sold exclusively.';
  end if;

  -- The swap itself. Rights cross over; creator credit does not move.
  update public.beats
    set rights_holder_id = o.recipient_id,
        status = 'traded'
    where id = o.offered_beat_id;

  update public.beats
    set rights_holder_id = o.proposer_id,
        status = 'traded'
    where id = o.wanted_beat_id;

  update public.trade_offers
    set status = 'accepted', resolved_at = now()
    where id = o.id;

  -- Any other pending offer involving either beat is now void.
  update public.trade_offers
    set status = 'cancelled', resolved_at = now()
    where status = 'pending'
      and id <> o.id
      and (offered_beat_id in (o.offered_beat_id, o.wanted_beat_id)
        or wanted_beat_id  in (o.offered_beat_id, o.wanted_beat_id));

  insert into public.trades (offer_id, party_a_id, beat_a_id, party_b_id, beat_b_id)
  values (o.id, o.proposer_id, o.offered_beat_id, o.recipient_id, o.wanted_beat_id)
  returning * into result;

  return result;
end;
$$;

-- ── 5. Row-level security ────────────────────────────────────────────────────

alter table public.trade_offers enable row level security;
alter table public.trades       enable row level security;

-- Offers are private correspondence: visible only to the two parties.
drop policy if exists "parties read own offers" on public.trade_offers;
create policy "parties read own offers"
  on public.trade_offers for select
  using (auth.uid() in (proposer_id, recipient_id));

-- You may only offer a beat you actually hold rights to, and only request
-- a beat the named recipient actually holds.
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

-- Declining / withdrawing. Acceptance goes through accept_trade_offer()
-- instead, because it must be atomic across several tables.
drop policy if exists "parties resolve own offers" on public.trade_offers;
create policy "parties resolve own offers"
  on public.trade_offers for update
  using (auth.uid() in (proposer_id, recipient_id));

drop policy if exists "parties read own trades" on public.trades;
create policy "parties read own trades"
  on public.trades for select
  using (auth.uid() in (party_a_id, party_b_id));

-- The ledger is append-only, and only accept_trade_offer() writes to it.
-- No insert/update/delete policy exists, so nothing else can.

-- ── 6. Beat write policies now follow rights, not authorship ─────────────────
--
-- Replaces the producer_id-based policies from schema.sql: after a trade,
-- the new rights holder is the one who can edit or re-list the beat.

drop policy if exists "producers update own beats" on public.beats;
create policy "rights holders update own beats"
  on public.beats for update using (auth.uid() = rights_holder_id);

drop policy if exists "producers delete own beats" on public.beats;
create policy "rights holders delete own beats"
  on public.beats for delete using (auth.uid() = rights_holder_id);

drop policy if exists "published beats are readable" on public.beats;
create policy "published beats are readable"
  on public.beats for select
  using (status <> 'draft' or auth.uid() in (producer_id, rights_holder_id));

-- License tiers follow rights too — the new holder sets the prices.
drop policy if exists "producers manage own license tiers" on public.license_tiers;
create policy "rights holders manage license tiers"
  on public.license_tiers for all
  using (
    exists (
      select 1 from public.beats b
      where b.id = license_tiers.beat_id and b.rights_holder_id = auth.uid()
    )
  );
