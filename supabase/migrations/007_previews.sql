-- beatbox — tagged previews and private clean files
--
-- Run after 006_producer_as_capability.sql. Idempotent.
--
-- Until now the clean file WAS the preview: audio_path pointed at a public
-- bucket and anyone could stream (or download) the full track. That means
-- the preview is the product and there is no reason to pay.
--
-- The fix has two halves:
--
--   1. The clean master moves to a PRIVATE bucket. It is never publicly
--      reachable — after purchase it is released as a short-lived signed
--      URL, which is why audio_path always stored a path and not a URL.
--
--   2. A tagged preview is generated and served publicly instead.
--
-- Producers pick how the preview is made:
--
--   supplied  — they upload their own pre-tagged preview
--   own_tag   — they upload a short tag (<=3s), laced in by the platform
--   platform  — beatbox laces in its own tag (the default)
--
-- A beat stays 'draft' until its preview exists, so nothing is ever listed
-- unprotected. If processing fails the beat simply never publishes, which
-- is the safe direction to fail in.

-- ── 1. Preview mode and state ────────────────────────────────────────────────

do $$ begin
  create type preview_mode as enum ('supplied', 'own_tag', 'platform');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type preview_state as enum ('pending', 'processing', 'ready', 'failed');
exception
  when duplicate_object then null;
end $$;

alter table public.beats
  add column if not exists preview_path text;

alter table public.beats
  add column if not exists preview_mode preview_mode not null default 'platform';

alter table public.beats
  add column if not exists preview_state preview_state not null default 'pending';

alter table public.beats
  add column if not exists preview_error text;

-- The producer's own tag, when preview_mode = 'own_tag'. Kept per beat
-- rather than per profile so a producer can use different tags for
-- different aliases.
alter table public.beats
  add column if not exists tag_path text;

comment on column public.beats.preview_path is
  'Tagged preview in the PUBLIC bucket. This is what streams. Null until
   processing completes.';
comment on column public.beats.audio_path is
  'Clean master in the PRIVATE bucket. Never served directly — released
   as a signed URL after purchase.';

create index if not exists beats_preview_state_idx
  on public.beats(preview_state) where preview_state <> 'ready';

-- ── 2. A beat cannot publish without a preview ───────────────────────────────
--
-- Enforced in the database rather than trusted to application code: this
-- is the one invariant that stops a clean file being exposed by a bug in
-- the upload path.

create or replace function public.enforce_preview_before_publish()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published'
     and (new.preview_path is null or new.preview_state <> 'ready') then
    raise exception
      'A beat cannot be published until its preview is ready.';
  end if;
  return new;
end;
$$;

drop trigger if exists beats_require_preview on public.beats;
create trigger beats_require_preview
  before insert or update on public.beats
  for each row execute function public.enforce_preview_before_publish();

-- Existing rows predate previews. Their audio is already public, so they
-- keep working: treat the current public file as its own preview rather
-- than un-publishing beats that are already live.
update public.beats
   set preview_path  = coalesce(preview_path, audio_path),
       preview_state = 'ready',
       preview_mode  = 'supplied'
 where preview_path is null;

-- ── 3. Buckets ───────────────────────────────────────────────────────────────
--
-- beat-audio was public. It now holds clean masters and must not be.
-- Storage policies from schema.sql already restrict writes by user folder;
-- flipping `public` is what stops anonymous reads.

update storage.buckets set public = false where id = 'beat-audio';

insert into storage.buckets (id, name, public)
values ('beat-previews', 'beat-previews', true)
on conflict (id) do nothing;

-- Producer tag uploads. Private: a tag is not meant to be downloadable on
-- its own, and keeping it private avoids handing anyone a clean copy of
-- another producer's tag to misuse.
insert into storage.buckets (id, name, public)
values ('beat-tags', 'beat-tags', false)
on conflict (id) do nothing;

-- ── 4. Storage policies ──────────────────────────────────────────────────────
--
-- Replaces the blanket read policy from schema.sql, which covered
-- beat-audio and would now expose clean masters.

drop policy if exists "anyone can read beat audio" on storage.objects;

-- Previews and artwork stream to anyone. Clean masters and tags do not.
create policy "anyone can read previews and artwork"
  on storage.objects for select
  using (bucket_id in ('beat-previews', 'beat-artwork'));

-- Owners can still read their own clean masters and tags — a producer
-- needs to be able to fetch back what they uploaded.
drop policy if exists "owners read own masters" on storage.objects;
create policy "owners read own masters"
  on storage.objects for select
  using (
    bucket_id in ('beat-audio', 'beat-tags')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Uploads stay namespaced by user id across all four buckets.
drop policy if exists "authenticated users upload to own folder" on storage.objects;
create policy "authenticated users upload to own folder"
  on storage.objects for insert
  with check (
    bucket_id in ('beat-audio', 'beat-artwork', 'beat-previews', 'beat-tags')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "users update own objects" on storage.objects;
create policy "users update own objects"
  on storage.objects for update
  using (
    bucket_id in ('beat-audio', 'beat-artwork', 'beat-previews', 'beat-tags')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "users delete own objects" on storage.objects;
create policy "users delete own objects"
  on storage.objects for delete
  using (
    bucket_id in ('beat-audio', 'beat-artwork', 'beat-previews', 'beat-tags')
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ── 5. Who may download a clean master ───────────────────────────────────────
--
-- The rights holder always may. Everyone else needs a license granting a
-- deliverable — which today only a trade issues, and later a purchase.
-- Called by the Edge Function that mints signed URLs; it is the single
-- decision point for "has this person paid for this file".

create or replace function public.can_download_master(p_beat_id uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.beats b
    where b.id = p_beat_id
      and b.rights_holder_id = p_user
  ) or exists (
    select 1 from public.licenses l
    where l.beat_id = p_beat_id
      and l.holder_id = p_user
  );
$$;

comment on function public.can_download_master is
  'Single decision point for releasing a clean master. Rights holders
   always qualify; everyone else needs a license row.';
