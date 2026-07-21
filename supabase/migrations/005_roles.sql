-- beatbox — user roles
--
-- Run after 004_rights_and_disputes.sql. Idempotent.
--
-- Mirrors the viewer/artist split from live-love-vomit, adapted to this
-- market's vocabulary: a buyer licenses beats, a producer also uploads and
-- trades them.
--
-- The important difference from that project: the role is NOT a JWT claim
-- signed by an application server. It lives on the profiles row, where
-- row-level security can read it directly. That keeps a single source of
-- truth — a role change takes effect immediately rather than when a
-- 7-day token happens to expire.

do $$ begin
  create type user_role as enum ('buyer', 'producer');
exception
  when duplicate_object then null;
end $$;

alter table public.profiles
  add column if not exists role user_role not null default 'buyer';

comment on column public.profiles.role is
  'buyer licenses beats; producer also uploads and trades. Read by RLS —
   never trust a role claim sent from the client.';

-- ── Role helper ──────────────────────────────────────────────────────────────
--
-- stable + security definer so policies can call it without every caller
-- needing read access to other people''s profile rows.

create or replace function public.is_producer(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'producer'
  );
$$;

-- ── Signup carries the chosen role ───────────────────────────────────────────
--
-- Replaces handle_new_user() from schema.sql. The role arrives in the
-- signup metadata; anything other than 'producer' falls back to 'buyer',
-- so a malformed or hostile value can only ever under-privilege.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested text;
begin
  requested := coalesce(new.raw_user_meta_data->>'role', 'buyer');

  insert into public.profiles (id, display_name, handle, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', 'producer'),
    nullif(new.raw_user_meta_data->>'handle', ''),
    case when requested = 'producer' then 'producer'::user_role
         else 'buyer'::user_role end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ── Users may not promote themselves ─────────────────────────────────────────
--
-- The profiles update policy from schema.sql lets a user edit their own
-- row, which would otherwise include `role`. This trigger pins the column:
-- a client-side update can change display_name or bio, never role.
--
-- Role changes go through an admin path (service role), which bypasses
-- triggers only if explicitly written to — so this stays enforced for
-- ordinary sessions.

create or replace function public.prevent_role_self_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    -- auth.uid() is null for service-role connections, which is how an
    -- admin path legitimately changes a role.
    if auth.uid() is not null then
      raise exception 'Roles cannot be changed from the client.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_pin_role on public.profiles;
create trigger profiles_pin_role
  before update on public.profiles
  for each row execute function public.prevent_role_self_change();

-- ── Only producers may upload ────────────────────────────────────────────────
--
-- Replaces the insert policy from schema.sql, which only checked that the
-- producer_id matched the caller.

drop policy if exists "producers insert own beats" on public.beats;
create policy "producers insert own beats"
  on public.beats for insert
  with check (
    auth.uid() = producer_id
    and public.is_producer(auth.uid())
  );

-- Existing accounts predate roles. Anyone who has already uploaded a beat
-- is evidently a producer; promote them so this migration doesn't lock
-- them out of their own catalog.
update public.profiles p
  set role = 'producer'
  where p.role = 'buyer'
    and exists (select 1 from public.beats b where b.producer_id = p.id);
