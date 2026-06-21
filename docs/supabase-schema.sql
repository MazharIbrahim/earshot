-- Earshot Postgres schema.
-- Mirrors the existing SQLite shape exactly so the Node backend can swap
-- between the two with a feature flag. Paste this into Supabase Dashboard
-- → SQL Editor → New query → Run.

create table if not exists public.takes (
    id              text primary key,
    project         text not null,
    project_id      text not null,
    filename        text not null,
    opus_filename   text,
    duration_sec    double precision not null,
    bytes           bigint not null,
    created_at      bigint not null,
    note            text,
    idempotency_key text
);

create index if not exists idx_takes_project
    on public.takes (project_id, created_at desc);

create unique index if not exists idx_takes_idem
    on public.takes (idempotency_key)
    where idempotency_key is not null;

-- For v1 we expose the table via the service_role key from the backend.
-- Once magic-link auth is wired we'll switch to a per-user user_id column
-- + RLS policy. For now keep it simple: row-level security disabled,
-- access only via the backend with the secret key.
alter table public.takes disable row level security;
