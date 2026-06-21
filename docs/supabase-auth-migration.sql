-- Migration to add per-user ownership to takes.
-- Paste into Supabase SQL Editor (https://supabase.com/dashboard/project/juypvyxapierfykgncsf/sql/new)
-- and click Run.

-- 1. Add the column. Nullable because pre-existing rows have no owner.
alter table public.takes
    add column if not exists user_id uuid references auth.users (id);

-- 2. Index for fast per-user listings.
create index if not exists idx_takes_user_project
    on public.takes (user_id, project_id, created_at desc);

-- 3. Optional: claim all current ownerless rows for your account.
-- Replace <YOUR_USER_ID> with your auth.users.id after you sign in once.
-- update public.takes set user_id = '<YOUR_USER_ID>' where user_id is null;

-- 4. RLS policies. service_role bypasses RLS so the backend is unaffected,
-- but anon/authenticated reads via the publishable key will now be scoped.
alter table public.takes enable row level security;

-- Authenticated users can do anything to their own takes.
create policy "own takes"
    on public.takes
    for all
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- Audio playback endpoint is intentionally public (share links). The
-- backend serves audio via service_role queries, so no anon policy is
-- needed unless you later want the PWA to query Supabase directly.
