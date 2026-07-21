-- beatbox — free beats
--
-- Run after 007_previews.sql. Idempotent.
--
-- A producer can give a beat away: free to use in any capacity,
-- commercially, forever, with no fee and no attribution required.
--
-- What "free" means here, precisely, because vague free terms are a
-- recurring source of disputes in this market:
--
--   The producer grants an unlimited licence and KEEPS OWNERSHIP. Users
--   may use it commercially, forever. The producer may still license it
--   to others, and may stop offering it going forward — but every grant
--   already made stays valid. This is not a transfer, and not CC0.
--
-- Consequences that follow from that, and are enforced below:
--
--   * No tagged preview. There is nothing to protect, so the clean file
--     is served directly and publishes immediately.
--   * Because the clean file is public, making a beat free is
--     irreversible in practice. Un-listing it cannot recall copies.
--   * A free beat cannot carry an exclusive tier: you cannot sell
--     exclusivity in something everyone already has a licence to.

-- ── 1. Free flag and its terms ───────────────────────────────────────────────

alter table public.beats
  add column if not exists is_free boolean not null default false;

alter table public.beats
  add column if not exists free_terms text;

alter table public.beats
  add column if not exists free_since timestamptz;

comment on column public.beats.is_free is
  'Free to use in any capacity. Producer keeps ownership; existing grants
   survive withdrawal.';
comment on column public.beats.free_terms is
  'Verbatim wording the producer agreed to when marking this free.
   Snapshotted, like the rights warranty, because the wording will change.';

create index if not exists beats_free_idx on public.beats(is_free) where is_free;

-- ── 2. Free beats skip preview processing ────────────────────────────────────
--
-- 007 refuses to publish a beat without a ready preview. For a free beat
-- there is nothing to protect, so the clean file IS the preview. This
-- relaxes the trigger for that case only.

create or replace function public.enforce_preview_before_publish()
returns trigger
language plpgsql
as $$
begin
  -- Free beats are served clean and need no generated preview.
  if new.is_free then
    return new;
  end if;

  if new.status = 'published'
     and (new.preview_path is null or new.preview_state <> 'ready') then
    raise exception
      'A beat cannot be published until its preview is ready.';
  end if;

  return new;
end;
$$;

-- ── 3. A free beat cannot be sold ────────────────────────────────────────────
--
-- Charging for something you have already licensed to everyone is
-- incoherent, and an exclusive tier on a free beat is a promise that
-- cannot be kept. Blocked at the database rather than in the form.

create or replace function public.enforce_free_beat_has_no_price()
returns trigger
language plpgsql
as $$
declare
  free boolean;
begin
  select b.is_free into free from public.beats b where b.id = new.beat_id;

  if free then
    raise exception
      'This beat is free — it cannot also carry a paid or exclusive licence.';
  end if;

  return new;
end;
$$;

drop trigger if exists license_tiers_not_on_free on public.license_tiers;
create trigger license_tiers_not_on_free
  before insert or update on public.license_tiers
  for each row execute function public.enforce_free_beat_has_no_price();

-- Marking an existing beat free must clear any tiers it already had,
-- otherwise the check above is trivially bypassed by changing the beat
-- rather than the tier.
create or replace function public.clear_tiers_when_freed()
returns trigger
language plpgsql
as $$
begin
  if new.is_free and not coalesce(old.is_free, false) then
    delete from public.license_tiers where beat_id = new.id;
    new.free_since := coalesce(new.free_since, now());
  end if;
  return new;
end;
$$;

drop trigger if exists beats_clear_tiers_when_freed on public.beats;
create trigger beats_clear_tiers_when_freed
  before update on public.beats
  for each row execute function public.clear_tiers_when_freed();

-- ── 4. Free beats cannot be traded ───────────────────────────────────────────
--
-- A free beat has no scarcity to exchange. Trading one for a paid
-- exclusive is a lopsided deal that the licences ledger would record as
-- an even swap, so the offer is refused outright.

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
        and not b.is_free
    )
    and exists (
      select 1 from public.beats b
      where b.id = wanted_beat_id
        and b.rights_holder_id = recipient_id
        and b.status <> 'sold_exclusive'
        and b.withdrawn_at is null
        and not b.is_free
    )
  );

-- ── 5. Claiming a free beat ──────────────────────────────────────────────────
--
-- Recorded as a licence like any other, so a user's library is one list
-- however each item was acquired, and so there is evidence of what terms
-- applied on the day it was taken.

do $$ begin
  alter type license_origin add value if not exists 'free';
exception
  when others then null;
end $$;

create or replace function public.claim_free_beat(p_beat_id uuid)
returns public.licenses
language plpgsql
security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  b      public.beats;
  result public.licenses;
begin
  if me is null then
    raise exception 'Sign in to claim this beat.';
  end if;

  select * into b from public.beats where id = p_beat_id;

  if not found then
    raise exception 'Beat not found.';
  end if;
  if not b.is_free then
    raise exception 'This beat is not free.';
  end if;
  if b.withdrawn_at is not null then
    raise exception 'This beat is no longer available.';
  end if;

  -- Claiming twice is not an error; return what they already hold.
  select * into result
    from public.licenses
   where beat_id = p_beat_id and holder_id = me and kind = 'lease'
   limit 1;

  if found then
    return result;
  end if;

  insert into public.licenses
    (beat_id, holder_id, kind, deliverable, terms, origin)
  values
    (p_beat_id, me, 'lease', 'wav',
     coalesce(b.free_terms, 'Free to use in any capacity.'), 'free')
  returning * into result;

  return result;
end;
$$;
