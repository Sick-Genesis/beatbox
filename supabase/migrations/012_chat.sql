-- beatbox — direct messages
--
-- Run after 011_purchases.sql. Idempotent.
--
-- Open DMs: anyone can message anyone by handle, no friend/follow gate.
-- This is a marketplace — a buyer messaging a producer about a beat (or a
-- producer answering) shouldn't need a prior relationship. That is also why
-- this ships without group chat or presence/status: those are social-network
-- features, not what a "message the producer" button needs.
--
-- A conversation is always exactly two people. Rather than a members join
-- table (needed for groups), it's just two columns — simpler, and a unique
-- constraint on the pair prevents duplicate DMs between the same two users.

-- ── 1. Conversations ─────────────────────────────────────────────────────────

create table if not exists public.conversations (
  id           uuid primary key default uuid_generate_v4(),

  -- Ordered low/high by uuid text value (see find_or_create_dm) so the same
  -- pair always lands in the same row regardless of who started it, and the
  -- unique constraint below actually catches duplicates.
  member_a     uuid not null references public.profiles(id) on delete cascade,
  member_b     uuid not null references public.profiles(id) on delete cascade,

  created_at   timestamptz not null default now(),
  -- Bumped on every new message; lets the contacts list sort by recency
  -- without a join into messages.
  updated_at   timestamptz not null default now(),

  check (member_a <> member_b),
  unique (member_a, member_b)
);

create index if not exists conversations_member_a_idx on public.conversations(member_a);
create index if not exists conversations_member_b_idx on public.conversations(member_b);

alter table public.conversations enable row level security;

drop policy if exists "members read their conversations" on public.conversations;
create policy "members read their conversations"
  on public.conversations for select
  using (auth.uid() = member_a or auth.uid() = member_b);

-- No direct insert policy: conversations are only created through
-- find_or_create_dm() below, which enforces the canonical member ordering
-- and runs as the calling user via auth.uid().

-- ── 2. Messages ──────────────────────────────────────────────────────────────

create table if not exists public.messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  text            text not null,
  created_at      timestamptz not null default now(),

  check (char_length(text) between 1 and 4000)
);

create index if not exists messages_conversation_idx on public.messages(conversation_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "members read conversation messages" on public.messages;
create policy "members read conversation messages"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  );

drop policy if exists "members send messages as themselves" on public.messages;
create policy "members send messages as themselves"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and (c.member_a = auth.uid() or c.member_b = auth.uid())
    )
  );

-- Bump the conversation's updated_at so the contacts list can sort on it
-- without joining messages every time.
create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ── 3. Open (or find) a DM ───────────────────────────────────────────────────
--
-- The one way conversations get created. Ordering member_a/member_b by uuid
-- text value means the same pair always maps to the same row, so the unique
-- constraint on (member_a, member_b) actually prevents duplicates — without
-- this, "me starts a DM with them" and "they start one with me" would
-- otherwise create two different rows.

create or replace function public.find_or_create_dm(p_other_id uuid)
returns public.conversations
language plpgsql
security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  a      uuid;
  b      uuid;
  result public.conversations;
begin
  if me is null then raise exception 'You need to be signed in to message someone.'; end if;
  if p_other_id = me then raise exception 'You cannot message yourself.'; end if;
  if not exists (select 1 from public.profiles where id = p_other_id) then
    raise exception 'That user could not be found.';
  end if;

  if me::text < p_other_id::text then a := me; b := p_other_id;
  else a := p_other_id; b := me;
  end if;

  select * into result from public.conversations
    where member_a = a and member_b = b;
  if found then return result; end if;

  insert into public.conversations (member_a, member_b)
  values (a, b)
  returning * into result;

  return result;
end;
$$;

-- ── 4. Find a user to message, by handle ─────────────────────────────────────
--
-- Backs the contacts search. Excludes the caller. Limited and prefix-only —
-- this is "start a DM," not a general user directory.

create or replace function public.search_messageable_users(p_query text)
returns setof public.profiles
language sql
stable
security definer set search_path = public
as $$
  select * from public.profiles
  where id <> auth.uid()
    and handle is not null
    and handle ilike p_query || '%'
  order by handle
  limit 20;
$$;

-- ── 5. Realtime ──────────────────────────────────────────────────────────────
--
-- New messages push to both members live, replacing what a raw WebSocket
-- server would otherwise be needed for.

do $$ begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end $$;
