# Earshot · Cloud migration guide

The local backend you're running today already speaks the same shape as the
cloud version. This guide walks through the swap, step by step. Budget: about
30 minutes of clicking, then `npm install` and an env file.

## What you get after this

- **Stable URL** like `app.earshot.fm` instead of a random `*.trycloudflare.com`
  that changes every restart.
- **Works when your laptop is off** — audio lives in Cloudflare R2, not your
  Application Support folder.
- **Real accounts** — magic-link email login. You can have collaborators with
  their own accounts and not see each other's projects.
- **Per-user storage limits** for the free tier so abuse doesn't burn money.

## Cost ceiling reminder (per heavy Pro user)

| Item | Cost |
|---|---|
| 30 GB stored on R2 | $0.45/mo |
| Egress (R2 is free) | $0 |
| LiveKit 10 h/day live monitoring | $0.70/mo |
| Auth + Postgres (Supabase) | shared, ~$0.01/user |
| **Total** | **~$1.20/mo per heavy user** |

Pro at $5/mo nets ~$3.40 after costs. Break-even on fixed costs (~$37/mo for
Supabase Pro + domain + monitoring) is **10 Pro subscribers**.

---

## Step 1 — Sign up

You'll need three free accounts. None of them charge you anything until you
hit non-trivial scale.

1. **Cloudflare** — for R2 (audio storage) and the named tunnel (stable URL).
   - <https://dash.cloudflare.com/sign-up>
2. **Supabase** — for Postgres + auth.
   - <https://supabase.com/dashboard/sign-up>
3. **Domain** — buy one. Cloudflare Registrar is at-cost (~$10/yr for `.fm`
   or `.io`; cheaper TLDs available). Transfer the nameservers to Cloudflare.

## Step 2 — Cloudflare R2 bucket

1. In the Cloudflare dashboard, **R2 → Create bucket**. Name: `earshot-takes`.
2. **Settings → Public access → Connect a custom domain.** Add
   `media.<yourdomain>`. Cloudflare provisions the cert automatically.
3. **R2 → Manage API tokens → Create token**. Permissions:
   *Object Read & Write* on `earshot-takes` only. Save the four values:
   - Access Key ID
   - Secret Access Key
   - Account ID (top-right of R2 page)
   - Bucket name (`earshot-takes`)

## Step 3 — Cloudflare named tunnel

The quick tunnel we use today rotates URLs. Named tunnels stick to a domain.

```bash
# One-time login (opens a browser tab to confirm)
cloudflared tunnel login

cloudflared tunnel create earshot
# → emits a UUID and writes ~/.cloudflared/<uuid>.json

cloudflared tunnel route dns earshot app.<yourdomain>
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <uuid-from-create>
credentials-file: /Users/<you>/.cloudflared/<uuid>.json

ingress:
  - hostname: app.<yourdomain>
    service: http://localhost:8787
  - service: http_status:404
```

Run it: `cloudflared tunnel run earshot`. To keep it running across reboots,
install as a launchd service: `sudo cloudflared service install`.

Once this is up, replace the quick-tunnel logic in `backend/src/server.js`
or just disable it: `EARSHOT_TUNNEL=off`.

## Step 4 — Supabase project

1. **New project**. Choose a region close to you. Save the database password.
2. **Settings → API**. Copy:
   - Project URL (`https://xxx.supabase.co`)
   - `anon` public key (used by the PWA)
   - `service_role` secret key (used by the backend)
3. **SQL Editor**. Paste the schema below — this is the same shape as our
   local SQLite schema, plus per-user scoping.

```sql
create table public.takes (
  id            text primary key,
  user_id       uuid not null references auth.users (id),
  project       text not null,
  project_id    text not null,
  filename      text not null,
  opus_filename text,
  duration_sec  real not null,
  bytes         bigint not null,
  created_at    bigint not null
);

create index takes_user_project_idx
  on public.takes (user_id, project_id, created_at desc);

-- Row-level security: a user can only see their own takes.
alter table public.takes enable row level security;

create policy "own takes only"
  on public.takes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

4. **Authentication → Providers → Email**. Enable *magic link*. (No password
   to manage. Users click a link from their inbox to sign in.)

## Step 5 — Backend env

Create `backend/.env` (gitignored):

```env
# storage
EARSHOT_STORAGE=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=earshot-takes
R2_PUBLIC_BASE=https://media.<yourdomain>

# disable the quick tunnel; the named tunnel covers this
EARSHOT_TUNNEL=off

# supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...
```

Install the R2 SDK (already in `optionalDependencies`):

```bash
cd backend && npm install
```

Backend changes needed (kept small, all marked `TODO(cloud)` in the source):

1. **Auth middleware**: verify the JWT on `Authorization: Bearer <token>`,
   reject 401 if invalid, attach `req.userId`.
2. **Postgres**: swap `better-sqlite3` for `pg` (or use Supabase's
   `@supabase/supabase-js` server client) and add `user_id = req.userId` to
   every SELECT/INSERT.
3. **Storage `put`**: already wired through `getStorage()`. Will use R2 when
   `EARSHOT_STORAGE=r2`.
4. **Audio endpoint**: `storage.url(key)` already returns the R2 public URL
   when configured; the handler redirects there automatically. Done.

## Step 6 — PWA env

Create `web/.env`:

```env
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_API_BASE=https://app.<yourdomain>
```

PWA changes:

1. Magic-link sign-in screen (already stubbed at `web/src/screens/SignIn.tsx`).
   Wire it to `supabase.auth.signInWithOtp({ email })`.
2. Send the JWT on every `fetch` in `web/src/api.ts`:
   ```ts
   const { data: { session } } = await supabase.auth.getSession();
   headers: { Authorization: `Bearer ${session?.access_token}` }
   ```
3. Sign-out button in the topbar.

## Step 7 — Plugin auth

The plugin needs to know whose account to upload to. Recommended flow:

1. Plugin shows a 6-digit "device code" + URL like
   `app.<yourdomain>/link?code=ABCDEF`.
2. User opens it on their phone (already signed in to the PWA), confirms.
3. Backend swaps the code for a long-lived JWT, returns it to the plugin.
4. Plugin stores the JWT in
   `~/Library/Application Support/Earshot/auth.json` and includes it on
   every upload.

This is implemented in `plugin/Source/Auth.cpp` once we get there.

## Step 8 — DNS, ATS, and final wiring

- DNS: `app.<yourdomain>` → tunnel, `media.<yourdomain>` → R2 bucket.
- Apple iOS only autoplays audio from HTTPS origins. Our tunnel is HTTPS so
  this works.
- Add a `robots.txt` disallowing crawl on the app subdomain.
- Set up a 1-line uptime check (e.g. UptimeRobot pointing at `/healthz`).

## Migration of existing local data (optional)

Quick script to copy your current local takes into R2 + Postgres:

```bash
cd backend
node scripts/migrate-to-r2.js   # TODO: write this when you're ready
```

It will:
1. Read every row from the local SQLite DB.
2. Upload each `.wav` + `.opus` to R2 under the same key.
3. Insert a corresponding row into Supabase Postgres (assigning your user_id).

---

## What's intentionally not in v1 cloud

- **WebRTC live monitoring.** Requires LiveKit Cloud account and a fair chunk
  of plugin work. Pro-tier feature for v2.
- **Multi-region storage.** R2 is global by default. Don't bother until you
  have non-US users complaining about latency.
- **Backups.** R2 already replicates within a region. Snapshot the Postgres DB
  daily via Supabase's built-in backups. That's enough.
