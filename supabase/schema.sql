-- beatbox — foundation schema
--
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- It is idempotent: safe to re-run.
--
-- Model, in short:
--   profiles        one row per user, created automatically on signup
--   beats           one row per uploaded beat, owned by a producer
--   license_tiers   the prices a beat is sold at (lease / premium / exclusive)
--
-- The licensing model is the load-bearing decision here. A beat is never
-- "sold" as a file — it is sold as a LICENSE, and the same beat can carry
-- several tiers at once. An exclusive purchase is the only one that
-- withdraws the beat from sale, which is why `beats.status` exists rather
-- than a boolean `sold` flag.

-- ── Extensions ───────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";

-- ── profiles ─────────────────────────────────────────────────────────────────
-- Mirrors auth.users. Supabase owns auth.users; we never write to it directly.

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique,
  display_name text,
  bio          text,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Public profile per user. Row is created automatically by handle_new_user().';

-- ── beats ────────────────────────────────────────────────────────────────────

do $$ begin
  create type beat_status as enum ('draft', 'published', 'sold_exclusive');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.beats (
  id           uuid primary key default uuid_generate_v4(),
  producer_id  uuid not null references public.profiles(id) on delete cascade,

  title        text not null,
  artist       text,

  -- Storage object paths, NOT public URLs. Resolved at read time so the
  -- bucket can stay private for clean files later without a migration.
  audio_path   text not null,
  artwork_path text,

  -- Buyers search by these two before anything else.
  bpm          integer check (bpm is null or (bpm > 0 and bpm < 400)),
  musical_key  text,

  tags         text[] not null default '{}',
  duration_sec numeric,

  status       beat_status not null default 'published',
  created_at   timestamptz not null default now()
);

create index if not exists beats_producer_idx on public.beats(producer_id);
create index if not exists beats_status_idx   on public.beats(status);
create index if not exists beats_tags_idx     on public.beats using gin(tags);

comment on column public.beats.audio_path is
  'Path within the storage bucket, e.g. "<user-id>/<uuid>.mp3". Not a URL.';

-- ── license_tiers ────────────────────────────────────────────────────────────

do $$ begin
  create type license_kind as enum ('lease', 'premium', 'exclusive');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.license_tiers (
  id           uuid primary key default uuid_generate_v4(),
  beat_id      uuid not null references public.beats(id) on delete cascade,

  kind         license_kind not null,
  price_cents  integer not null check (price_cents >= 0),
  currency     text not null default 'usd',

  -- What the buyer actually receives, and what they may do with it.
  deliverable  text not null default 'mp3',   -- mp3 | wav | stems
  terms        text,

  created_at   timestamptz not null default now(),

  unique (beat_id, kind)
);

create index if not exists license_tiers_beat_idx on public.license_tiers(beat_id);

-- ── Auto-create a profile on signup ──────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'producer'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Row-level security ───────────────────────────────────────────────────────
-- Without these policies every table is readable by anyone with the anon key.
-- Read is public (it is a shop); write is restricted to the owner.

alter table public.profiles      enable row level security;
alter table public.beats         enable row level security;
alter table public.license_tiers enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable"
  on public.profiles for select using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Drafts stay private to their producer; everything else is shop-visible.
drop policy if exists "published beats are readable" on public.beats;
create policy "published beats are readable"
  on public.beats for select
  using (status <> 'draft' or auth.uid() = producer_id);

drop policy if exists "producers insert own beats" on public.beats;
create policy "producers insert own beats"
  on public.beats for insert with check (auth.uid() = producer_id);

drop policy if exists "producers update own beats" on public.beats;
create policy "producers update own beats"
  on public.beats for update using (auth.uid() = producer_id);

drop policy if exists "producers delete own beats" on public.beats;
create policy "producers delete own beats"
  on public.beats for delete using (auth.uid() = producer_id);

drop policy if exists "license tiers are readable" on public.license_tiers;
create policy "license tiers are readable"
  on public.license_tiers for select using (true);

-- Tier writes are gated on owning the parent beat.
drop policy if exists "producers manage own license tiers" on public.license_tiers;
create policy "producers manage own license tiers"
  on public.license_tiers for all
  using (
    exists (
      select 1 from public.beats b
      where b.id = license_tiers.beat_id and b.producer_id = auth.uid()
    )
  );

-- ── Storage buckets ──────────────────────────────────────────────────────────
-- Public for now: previews must stream without auth. When watermarking lands
-- (next stage), clean files move to a separate private bucket served through
-- signed URLs after purchase.

insert into storage.buckets (id, name, public)
values ('beat-audio', 'beat-audio', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('beat-artwork', 'beat-artwork', true)
on conflict (id) do nothing;

-- Uploads are namespaced by user id: "<user-id>/<file>". The policies below
-- enforce that prefix so one producer cannot overwrite another's files.

drop policy if exists "anyone can read beat audio" on storage.objects;
create policy "anyone can read beat audio"
  on storage.objects for select
  using (bucket_id in ('beat-audio', 'beat-artwork'));

drop policy if exists "authenticated users upload to own folder" on storage.objects;
create policy "authenticated users upload to own folder"
  on storage.objects for insert
  with check (
    bucket_id in ('beat-audio', 'beat-artwork')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "users update own objects" on storage.objects;
create policy "users update own objects"
  on storage.objects for update
  using (
    bucket_id in ('beat-audio', 'beat-artwork')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "users delete own objects" on storage.objects;
create policy "users delete own objects"
  on storage.objects for delete
  using (
    bucket_id in ('beat-audio', 'beat-artwork')
    and auth.uid()::text = (storage.foldername(name))[1]
  );
