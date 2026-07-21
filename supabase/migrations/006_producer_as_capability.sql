-- beatbox — producer as an earned capability, not an identity
--
-- Run after 005_roles.sql. Idempotent.
--
-- 005 modelled buyer/producer as a choice made at signup. That was wrong
-- in two ways:
--
--   1. It implied producers don't buy. They do — producers licensing and
--      trading each other's beats is much of the activity in this market.
--      Nothing ever gated purchasing on role, so the schema was fine; the
--      signup UI simply lied about it.
--
--   2. It created dead-end accounts. Pick 'buyer', later want to upload,
--      and there was no way out: self-promotion is blocked by trigger and
--      there is no admin surface. You would have to make a second account.
--
-- The fix: everyone can buy, license and trade from the moment they sign
-- up. Producer is what you BECOME by accepting the rights warranty and
-- uploading. The warranty stays the gate — it just promotes you rather
-- than being something only pre-declared producers may reach.

-- ── 1. Everyone starts as a buyer ────────────────────────────────────────────
--
-- Replaces the 005 version, which honoured a 'role' key in the signup
-- metadata. Nothing sends that any more, and honouring it would let a
-- crafted signup request skip the warranty.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, handle, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', 'listener'),
    nullif(new.raw_user_meta_data->>'handle', ''),
    'buyer'::user_role      -- always; producer is earned, never requested
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ── 2. Accepting the warranty promotes you ───────────────────────────────────
--
-- The one supported route from buyer to producer. security definer so it
-- can write the role column that prevent_role_self_change() otherwise
-- pins — this function IS the sanctioned path, so it sets a flag the
-- trigger recognises.

create or replace function public.become_producer(warranty_text text)
returns public.profiles
language plpgsql
security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  result public.profiles;
begin
  if me is null then
    raise exception 'You need to be signed in.';
  end if;

  if warranty_text is null or length(trim(warranty_text)) < 20 then
    raise exception 'The rights declaration is required to upload beats.';
  end if;

  -- Recorded on the profile so there is evidence of when the account
  -- accepted producer responsibilities, and to what wording — the same
  -- reasoning as the per-beat warranty in 004.
  update public.profiles
     set role = 'producer',
         producer_since = coalesce(producer_since, now()),
         producer_warranty_text = warranty_text
   where id = me
  returning * into result;

  return result;
end;
$$;

alter table public.profiles
  add column if not exists producer_since timestamptz;

alter table public.profiles
  add column if not exists producer_warranty_text text;

comment on column public.profiles.producer_since is
  'When this account accepted producer responsibilities. Null = buyer.';

-- ── 3. Let the sanctioned path through the role-pinning trigger ──────────────
--
-- 005 blocked every client-side role change. become_producer() is
-- security definer but still runs with a non-null auth.uid(), so it would
-- trip that trigger. Allow exactly the buyer -> producer transition, and
-- only when the warranty columns are being set alongside it.

create or replace function public.prevent_role_self_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    -- Service-role connections (auth.uid() is null) are the admin path.
    if auth.uid() is null then
      return new;
    end if;

    -- The one permitted self-service transition: becoming a producer by
    -- accepting the warranty. Demotion and anything else stays blocked.
    if old.role = 'buyer'
       and new.role = 'producer'
       and new.producer_warranty_text is not null
       and new.producer_since is not null then
      return new;
    end if;

    raise exception 'Roles cannot be changed from the client.';
  end if;

  return new;
end;
$$;

-- ── 4. Backfill ──────────────────────────────────────────────────────────────
--
-- Accounts already marked producer by 005 keep the role; give them a
-- producer_since so the column is meaningful for everyone who has it.

update public.profiles
   set producer_since = coalesce(producer_since, now())
 where role = 'producer' and producer_since is null;
