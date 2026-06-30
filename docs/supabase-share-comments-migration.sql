-- Share tokens + comments.
-- Paste into Supabase SQL Editor and run.
-- https://supabase.com/dashboard/project/juypvyxapierfykgncsf/sql/new

-- ---------- share tokens ----------
-- One row per share-link. Anyone holding the token can read the linked
-- take + its comments. Owner can delete to revoke.
create table if not exists public.share_tokens (
    token       uuid primary key default gen_random_uuid(),
    take_id     text not null references public.takes(id) on delete cascade,
    created_by  uuid references auth.users(id),
    created_at  bigint not null,
    expires_at  bigint -- nullable: null = never expires
);

create index if not exists idx_share_tokens_take
    on public.share_tokens (take_id);

alter table public.share_tokens enable row level security;

drop policy if exists "own share tokens" on public.share_tokens;
create policy "own share tokens"
    on public.share_tokens
    for all
    to authenticated
    using (auth.uid() = created_by)
    with check (auth.uid() = created_by);

grant select, insert, update, delete on public.share_tokens to authenticated, service_role;

-- ---------- comments ----------
-- Either anchored to a specific moment in the take (timestamp_sec) or
-- general (timestamp_sec null). Authored either by a signed-in user
-- (user_id) or — if we ever allow it on share links — anonymous with
-- just a display name (email/name). v1 requires sign-in to comment.
create table if not exists public.comments (
    id            uuid primary key default gen_random_uuid(),
    take_id       text not null references public.takes(id) on delete cascade,
    user_id       uuid references auth.users(id),
    author_email  text,         -- denormalised for display
    text          text not null check (length(text) > 0 and length(text) <= 1000),
    timestamp_sec real,         -- null = general comment
    created_at    bigint not null
);

create index if not exists idx_comments_take_created
    on public.comments (take_id, created_at);

alter table public.comments enable row level security;

-- Anyone authenticated can read comments on takes they can see (or that
-- have an active share token they hold — handled at the API layer).
drop policy if exists "comments read" on public.comments;
create policy "comments read"
    on public.comments
    for select
    to authenticated
    using (true);

-- Authenticated users can write comments under their own user_id only.
drop policy if exists "comments write" on public.comments;
create policy "comments write"
    on public.comments
    for insert
    to authenticated
    with check (auth.uid() = user_id);

-- Edit/delete only your own.
drop policy if exists "comments modify" on public.comments;
create policy "comments modify"
    on public.comments
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

grant select, insert, update, delete on public.comments to authenticated, service_role;
