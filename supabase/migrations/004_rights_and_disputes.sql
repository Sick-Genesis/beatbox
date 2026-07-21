-- beatbox — rights warranties, takedowns, and trade valuation
--
-- Run after 003_lease_trades.sql. Idempotent.
--
-- NOT LEGAL ADVICE. This migration adds the DATA STRUCTURES that make
-- compliance possible. It does not make the platform compliant. Actual
-- terms of service, a designated DMCA agent, and jurisdiction-specific
-- advice are separate work, and for a multi-producer platform they need a
-- lawyer who knows music licensing.
--
-- Three things here:
--   1. A rights warranty recorded at upload — who claimed what, and when
--   2. Takedown/dispute reports and the machinery to act on them
--   3. Declared value on trades, for the tax position barter creates

-- ── 1. Rights warranty at upload ─────────────────────────────────────────────
--
-- The producer affirms they own what they are uploading. Recording the
-- affirmation — with a timestamp and the exact wording shown — is what
-- makes it evidence later. Storing only a boolean would prove nothing
-- about what they actually agreed to.

alter table public.beats
  add column if not exists rights_warranted_at timestamptz;

alter table public.beats
  add column if not exists rights_warranty_text text;

-- Whether the producer declares any third-party samples. Uncleared samples
-- are the most common source of infringement claims in this market, so it
-- is worth capturing the claim explicitly rather than inferring silence.
alter table public.beats
  add column if not exists contains_samples boolean;

alter table public.beats
  add column if not exists sample_notes text;

comment on column public.beats.rights_warranted_at is
  'When the uploader affirmed they hold the rights. Null = never affirmed.';
comment on column public.beats.rights_warranty_text is
  'Verbatim wording the uploader agreed to. Snapshotted, since the wording
   on the upload form will change over time.';

-- ── 2. Takedown / dispute reports ────────────────────────────────────────────

do $$ begin
  create type report_kind as enum (
    'copyright',      -- "this is my work / uses my work"
    'uncleared_sample',
    'impersonation',
    'trade_dispute',  -- a completed trade is contested
    'other'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type report_status as enum (
    'open',
    'under_review',
    'upheld',      -- claim accepted; content actioned
    'rejected',
    'withdrawn'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.reports (
  id            uuid primary key default uuid_generate_v4(),

  -- Nullable: a rights holder who is not a user must still be able to
  -- file. Anonymous reports arrive with contact details instead.
  reporter_id   uuid references public.profiles(id) on delete set null,
  reporter_name  text,
  reporter_email text,

  kind          report_kind not null,
  status        report_status not null default 'open',

  -- What is being reported. At least one must be set.
  beat_id       uuid references public.beats(id) on delete cascade,
  trade_id      uuid references public.trades(id) on delete set null,

  claim         text not null,
  evidence_url  text,

  -- Filled in when resolved. Kept for the repeat-infringer policy that
  -- safe-harbour regimes require you to actually operate.
  resolution_note text,
  resolved_at     timestamptz,
  resolved_by     uuid references public.profiles(id) on delete set null,

  created_at    timestamptz not null default now(),

  constraint report_has_target check (beat_id is not null or trade_id is not null),
  constraint report_has_contact check (
    reporter_id is not null or reporter_email is not null
  )
);

create index if not exists reports_beat_idx   on public.reports(beat_id);
create index if not exists reports_status_idx on public.reports(status);

-- ── 3. Takedown state on beats ───────────────────────────────────────────────
--
-- Separate from `status`. A beat can be withdrawn for a rights claim
-- regardless of whether it is draft, published, traded, or sold — the two
-- axes are independent, so overloading the status enum would lose
-- information.

alter table public.beats
  add column if not exists withdrawn_at timestamptz;

alter table public.beats
  add column if not exists withdrawn_reason text;

comment on column public.beats.withdrawn_at is
  'Set when a beat is pulled following a report. Independent of `status`:
   a traded or sold beat can still be withdrawn.';

create index if not exists beats_withdrawn_idx
  on public.beats(withdrawn_at) where withdrawn_at is not null;

-- Withdrawn beats disappear from the shop for everyone except the people
-- entitled to see them. This REPLACES the read policy from 002.
drop policy if exists "published beats are readable" on public.beats;
create policy "published beats are readable"
  on public.beats for select
  using (
    (status <> 'draft' and withdrawn_at is null)
    or auth.uid() in (producer_id, rights_holder_id)
  );

-- ── 4. Withdrawn beats cannot be traded ──────────────────────────────────────
--
-- Belt and braces: the insert policy blocks new offers, and
-- accept_trade_offer() re-checks at settlement (section 6), since a beat
-- may be withdrawn after an offer is made but before it is accepted.

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
        and b.withdrawn_at is null
        and b.rights_warranted_at is not null
    )
    and exists (
      select 1 from public.beats b
      where b.id = wanted_beat_id
        and b.rights_holder_id = recipient_id
        and b.status <> 'sold_exclusive'
        and b.withdrawn_at is null
    )
  );

-- ── 5. Declared value on trades ──────────────────────────────────────────────
--
-- Barter is taxable in most jurisdictions: each party owes tax on the fair
-- market value of what they received, even though no money moved. People
-- routinely do not expect this.
--
-- Recording a declared value per side gives both parties something to
-- report, and gives the platform a defensible position that it asked.
-- It is a DECLARATION BY THE PARTIES, not a valuation by the platform —
-- the distinction matters, and the UI wording should preserve it.

alter table public.trade_offers
  add column if not exists offered_declared_value_cents integer
    check (offered_declared_value_cents is null or offered_declared_value_cents >= 0);

alter table public.trade_offers
  add column if not exists wanted_declared_value_cents integer
    check (wanted_declared_value_cents is null or wanted_declared_value_cents >= 0);

alter table public.trades
  add column if not exists beat_a_declared_value_cents integer;
alter table public.trades
  add column if not exists beat_b_declared_value_cents integer;

comment on column public.trades.beat_a_declared_value_cents is
  'Value declared by the parties for tax purposes. Not a platform valuation.';

-- ── 6. Settlement re-checks withdrawal and warranty ──────────────────────────
--
-- Replaces the 003 version. Same structure; adds two gates and carries
-- declared values through to the ledger.

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

  if o.offered_beat_id < o.wanted_beat_id then
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
  else
    select * into beat_wanted  from public.beats where id = o.wanted_beat_id  for update;
    select * into beat_offered from public.beats where id = o.offered_beat_id for update;
  end if;

  if beat_offered.rights_holder_id <> o.proposer_id then
    update public.trade_offers set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'The offered beat no longer belongs to the person who proposed this trade.';
  end if;

  if beat_wanted.rights_holder_id <> o.recipient_id then
    update public.trade_offers set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'You no longer hold the rights to the beat being requested.';
  end if;

  if beat_offered.status = 'sold_exclusive' then
    raise exception 'The offered beat has already been sold exclusively.';
  end if;
  if beat_wanted.status = 'sold_exclusive' then
    raise exception 'Your beat has already been sold exclusively.';
  end if;

  -- A beat withdrawn under a rights claim between the offer and the
  -- acceptance must not change hands.
  if beat_offered.withdrawn_at is not null then
    update public.trade_offers set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'The offered beat has been withdrawn pending a rights claim.';
  end if;
  if beat_wanted.withdrawn_at is not null then
    update public.trade_offers set status = 'cancelled', resolved_at = now() where id = o.id;
    raise exception 'Your beat has been withdrawn pending a rights claim.';
  end if;

  -- Nobody can grant rights they never claimed to hold.
  if beat_offered.rights_warranted_at is null then
    raise exception 'The offered beat has no rights declaration from its uploader.';
  end if;
  if beat_wanted.rights_warranted_at is null then
    raise exception 'Your beat needs a rights declaration before it can be traded.';
  end if;

  -- Side A
  select o_deliverable, o_terms into v_deliverable, v_terms
    from public.resolve_tier_terms(o.offered_beat_id, o.offered_kind);

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin)
  values
    (o.offered_beat_id, o.recipient_id, o.offered_kind, v_deliverable, v_terms, 'trade');

  if o.offered_kind = 'exclusive' then
    update public.beats
      set rights_holder_id = o.recipient_id, status = 'traded'
      where id = o.offered_beat_id;
  end if;

  -- Side B
  select o_deliverable, o_terms into v_deliverable, v_terms
    from public.resolve_tier_terms(o.wanted_beat_id, o.wanted_kind);

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin)
  values
    (o.wanted_beat_id, o.proposer_id, o.wanted_kind, v_deliverable, v_terms, 'trade');

  if o.wanted_kind = 'exclusive' then
    update public.beats
      set rights_holder_id = o.proposer_id, status = 'traded'
      where id = o.wanted_beat_id;
  end if;

  update public.trade_offers
    set status = 'accepted', resolved_at = now()
    where id = o.id;

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
    (offer_id,
     party_a_id, beat_a_id, beat_a_kind, beat_a_declared_value_cents,
     party_b_id, beat_b_id, beat_b_kind, beat_b_declared_value_cents)
  values
    (o.id,
     o.proposer_id,  o.offered_beat_id, o.offered_kind, o.offered_declared_value_cents,
     o.recipient_id, o.wanted_beat_id,  o.wanted_kind,  o.wanted_declared_value_cents)
  returning * into result;

  return result;
end;
$$;

-- ── 7. Report RLS ────────────────────────────────────────────────────────────

alter table public.reports enable row level security;

-- Anyone may file, including people with no account. This is deliberate:
-- a rights holder who has never used beatbox must still be able to
-- complain, or the takedown process is not usable by the people most
-- likely to need it.
drop policy if exists "anyone can file a report" on public.reports;
create policy "anyone can file a report"
  on public.reports for insert with check (true);

-- Reporters see their own; beat owners see reports filed against them.
-- Reporter contact details are visible to the beat owner, which is normal
-- for a counter-notice process but should be stated in the terms.
drop policy if exists "reporters and owners read reports" on public.reports;
create policy "reporters and owners read reports"
  on public.reports for select
  using (
    auth.uid() = reporter_id
    or exists (
      select 1 from public.beats b
      where b.id = reports.beat_id
        and auth.uid() in (b.producer_id, b.rights_holder_id)
    )
  );

-- No update policy: resolving a report is a moderation action and needs an
-- admin path (service role or a moderator role), not client-side writes.
