-- Collaborators + shared-with-me + tier flag.
-- Paste into Supabase SQL Editor and run.
-- https://supabase.com/dashboard/project/juypvyxapierfykgncsf/sql/new

-- ---------- project members ----------
-- A user gets read access to all takes under (owner_user_id, project_id)
-- when they hold a member row for that pair. Email is always set so we
-- can invite people before they have an account; once they sign up,
-- the backend fills in member_user_id from the auth.users row.
create table if not exists public.project_members (
    owner_user_id   uuid not null references auth.users(id),
    project_id      text not null,
    member_email    text not null,
    member_user_id  uuid references auth.users(id),
    role            text not null default 'viewer'
                    check (role in ('viewer', 'commenter', 'editor')),
    invited_at      bigint not null,
    primary key (owner_user_id, project_id, member_email)
);

create index if not exists idx_project_members_member
    on public.project_members (member_user_id);
create index if not exists idx_project_members_email
    on public.project_members (lower(member_email));

alter table public.project_members enable row level security;

drop policy if exists "members read" on public.project_members;
create policy "members read"
    on public.project_members
    for select to authenticated
    using (auth.uid() = owner_user_id or auth.uid() = member_user_id);

drop policy if exists "members write" on public.project_members;
create policy "members write"
    on public.project_members
    for all to authenticated
    using (auth.uid() = owner_user_id)
    with check (auth.uid() = owner_user_id);

grant select, insert, update, delete on public.project_members to authenticated, service_role;


-- ---------- update takes RLS to include collaborators ----------
drop policy if exists "own takes" on public.takes;
create policy "own takes"
    on public.takes
    for all to authenticated
    using (
        auth.uid() = user_id
        or exists (
            select 1 from public.project_members pm
            where pm.owner_user_id = public.takes.user_id
              and pm.project_id    = public.takes.project_id
              and pm.member_user_id = auth.uid()
        )
    )
    with check (auth.uid() = user_id);


-- ---------- share recipients (the "shared with me" inbox) ----------
-- When a share token is created, owner can optionally name an email.
-- A user with that email signed in sees a "shared with me" entry in
-- their library. Independent from project_members because share is
-- a single-take grant, not project-wide.
create table if not exists public.share_recipients (
    token          uuid not null references public.share_tokens(token) on delete cascade,
    invited_email  text not null,
    invited_at     bigint not null,
    primary key (token, invited_email)
);

create index if not exists idx_share_recipients_email
    on public.share_recipients (lower(invited_email));

alter table public.share_recipients enable row level security;

drop policy if exists "share_recipients read" on public.share_recipients;
create policy "share_recipients read"
    on public.share_recipients
    for select to authenticated
    using (
        -- The owner of the share token can see who they invited.
        exists (
            select 1 from public.share_tokens st
            where st.token = public.share_recipients.token
              and st.created_by = auth.uid()
        )
        -- The invited user can see their own invites.
        or lower(invited_email) = lower(coalesce((select email from auth.users where id = auth.uid()), ''))
    );

drop policy if exists "share_recipients write" on public.share_recipients;
create policy "share_recipients write"
    on public.share_recipients
    for all to authenticated
    using (
        exists (
            select 1 from public.share_tokens st
            where st.token = public.share_recipients.token
              and st.created_by = auth.uid()
        )
    )
    with check (
        exists (
            select 1 from public.share_tokens st
            where st.token = public.share_recipients.token
              and st.created_by = auth.uid()
        )
    );

grant select, insert, update, delete on public.share_recipients to authenticated, service_role;


-- ---------- profile / tier ----------
-- One row per auth user holding our app-level state: which subscription
-- tier they're on, etc. user_id is the FK so we can RLS by it cleanly.
create table if not exists public.profiles (
    user_id       uuid primary key references auth.users(id) on delete cascade,
    email         text,
    tier          text not null default 'free'
                  check (tier in ('free', 'pro', 'studio')),
    stripe_customer_id text,
    pro_since     bigint,
    created_at    bigint not null default extract(epoch from now()) * 1000
);

alter table public.profiles enable row level security;

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read"
    on public.profiles for select to authenticated
    using (auth.uid() = user_id);

drop policy if exists "own profile write" on public.profiles;
create policy "own profile write"
    on public.profiles for all to authenticated
    using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.profiles to authenticated, service_role;
