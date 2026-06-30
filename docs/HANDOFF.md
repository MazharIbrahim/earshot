# Earshot — session handoff

**Last updated:** 2026-07-01.
**Read this first** if you're continuing in a new chat. Reference it back to the assistant: "Read docs/HANDOFF.md before doing anything."

## What Earshot is

A VST3/AU plugin + PWA. The plugin records snapshots of your in-progress
tracks from the DAW's master bus; the PWA lets you play them on your
phone, comment, share, and collaborate. Positioning: **version history
for your work-in-progress music**, not "stream your DAW".

Tagline: *Your studio, in your pocket.*

## Live URLs

| Surface | URL |
|---|---|
| App + API | https://app.earshot.cc |
| Marketing (placeholder, not built yet) | https://earshot.cc |
| Audio CDN (R2) | https://pub-d4b4722a199246d380de2fac6d710663.r2.dev |
| GitHub | https://github.com/MazharIbrahim/earshot |
| Render dashboard | https://dashboard.render.com/web/srv-d8s02hb6sc1c73bs9e50 |
| Supabase | https://supabase.com/dashboard/project/juypvyxapierfykgncsf |
| LemonSqueezy | https://app.lemonsqueezy.com/products/1186810 |

## Architecture in one diagram

```
┌─ DAW (Ableton/etc.) — plugin records master bus
│   └─ Earshot.vst3 (C++ / JUCE 7.0.12)
│       ├─ Captures 16-bit WAV on REC + transport play
│       ├─ Direct-to-R2 multipart upload (5MB chunks)
│       └─ Device-link auth → HS256 JWT, persisted to
│            ~/Library/Application Support/Earshot/auth.json
│
├─ Backend (Node 20 + Express) on Render
│   srv-d8s02hb6sc1c73bs9e50
│   ├─ JWT verify (Supabase RS256 OR plugin HS256)
│   ├─ ffmpeg transcode WAV → Opus (libopus, async after upload)
│   ├─ Supabase Postgres for ALL metadata
│   ├─ R2 for audio bytes
│   ├─ Resend for transactional email
│   └─ LemonSqueezy for billing
│
├─ PWA (Vite + React + TS) — same origin as API
│   ├─ Magic-link sign-in via @supabase/auth-js
│   ├─ A/B player, share tokens, comments, collaborators,
│   │  shared-with-me inbox, Pro upgrade chip
│   └─ /s/:token route for public share view
│
└─ Cloudflare
    ├─ Registrar (earshot.cc)
    ├─ DNS
    ├─ R2 bucket "earshot-takes"
    └─ TLS via Render (DNS-only CNAME)
```

## Repo layout

```
plugin/        JUCE 7.0.12 VST3 (C++)
  Source/
    PluginProcessor / PluginEditor       — main plumbing + UI
    CaptureBuffer / TakeWriter            — audio capture
    Uploader                              — R2 multipart upload
    HealthPoller / TakesPoller / ProjectsPoller
    SignInFlow                            — device-code auth
    BrandLookAndFeel                      — visual identity
  third_party/JUCE (submodule), qrcodegen (vendored)

backend/       Node 20 + Express
  src/
    server.js         — all routes, single file
    db.js             — Postgres adapter via PostgREST + service_role
    storage.js        — R2 (or Supabase Storage) abstraction
    transcode.js      — ffmpeg-static wrapper
    auth.js           — Bearer JWT verify (Supabase + plugin tokens)
    devicelink.js     — plugin sign-in flow
    billing.js        — LemonSqueezy checkouts + webhook verify
    mailer.js         — Resend integration
    tunnel.js         — local dev only (cloudflared)

web/           Vite + React + TS PWA
  src/
    App.tsx, auth.tsx, api.ts
    screens/
      Library, Project, SignIn, Link, Shared, Comments, Members

docs/
  HANDOFF.md (this file)
  CLOUD.md
  plan.md
  supabase-*-migration.sql    — all SQL migrations run, in order
  affiliate-hub-copy.md
  pro-unit-economics.md
```

## All credentials / accounts in use

**Never put these in source.** They live in Render env vars or local `.env`.

| Service | Owner | Where the key lives |
|---|---|---|
| GitHub | Mazhar | PAT was rotated (or should be) — Render uses GitHub OAuth |
| Render | Mazhar | API key kept by user. Workspace `tea-d8rucamgvqtc73fic5sg` |
| Supabase | Mazhar | URL + service key in Render env; anon key public in PWA bundle |
| Cloudflare R2 | Mazhar | Account ID `63c43aa6fd165d07a151c5a80d8f1cb2`, bucket `earshot-takes` |
| Resend | Mazhar | API key in Render env. Domain `earshot.cc` verified |
| LemonSqueezy | Mazhar | Store id `421593` ("Earshot"), product `1186810`, variant `1855895` |

## Env vars on Render (srv-d8s02hb6sc1c73bs9e50)

| Var | Purpose |
|---|---|
| `EARSHOT_DB` = `supabase` | Postgres backend on |
| `EARSHOT_STORAGE` = `r2` | R2 for audio |
| `EARSHOT_AUTH` = `on` | JWT required for protected routes |
| `EARSHOT_TUNNEL` = `off` | No quick tunnel in prod |
| `EARSHOT_MAILER` = `resend` | Real email |
| `EARSHOT_MAIL_FROM` = `Earshot <noreply@earshot.cc>` | Branded sender |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`=`earshot-takes`, `R2_PUBLIC_BASE` | R2 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Postgres + auth |
| `PLUGIN_JWT_SECRET` | HS256 for plugin device-link tokens |
| `RESEND_API_KEY` | Email |
| `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`=`421593`, `LEMONSQUEEZY_PRO_VARIANT_ID`=`1855895`, `LEMONSQUEEZY_WEBHOOK_SECRET` | Billing |
| `NODE_VERSION` = `20.20.2` | Node lock |
| `PORT` = `8787` | Render listens here |

## SQL migrations applied to Supabase, in order

All files in `docs/`. If a new Supabase project is set up, replay in this order:

1. `supabase-schema.sql` — base `takes` table
2. `supabase-auth-migration.sql` — `user_id` column + RLS for "own takes"
3. `supabase-share-comments-migration.sql` — `share_tokens`, `comments`
4. `supabase-collab-migration.sql` — `project_members`, `share_recipients`, `profiles`, updated takes RLS

Plus a manual SQL block the user ran granting privileges on the takes
table to service_role and authenticated.

## Architecture-level decisions worth remembering

1. **All audio bytes go directly between plugin/phone and R2.** Render
   never proxies media. Uploads use S3 multipart with presigned PUTs;
   playback redirects to R2 public URL. R2's free egress is the entire
   economic basis for the unit economics.
2. **No `projects` table.** A "project" is a slug derived from
   project_name, attached to each take row. The slug `(owner_user_id,
   project_id)` is the de facto project identity. `project_members` keys
   off that pair.
3. **Authentication has two issuers.** Supabase Auth (RS256 via JWKS)
   for PWA users, and a backend-minted HS256 token (signed with
   `PLUGIN_JWT_SECRET`) for the plugin's device-link flow. The
   `verifyJwt` helper tries local HS256 first, falls back to JWKS.
4. **Service-role bypass for all DB writes.** RLS is configured
   correctly, but the Node backend always uses the service_role key.
   Authorization happens at the API layer (ownership / membership
   checks), not in PostgREST.
5. **Plugin: bytes are buffered in memory.** No streaming. Fine for
   takes under ~50 MB. If you ever need bigger, see "future ideas".

## Round-by-round progress (compressed)

This is everything we built. If a new session needs detail, search the
git log for any keyword from below.

| # | Round | Net outcome |
|---|---|---|
| 1 | Plan + plugin scaffold | VST3 builds, loads in Ableton |
| 2 | Audio tap + ring buffer + WAV writer | Snapshot recording end to end |
| 3 | Manual REC + level meter | Producer-facing UX |
| 4 | Arm-and-wait mode | One-click capture of next play-through |
| 5 | Local backend (Express + SQLite + multer) | First end-to-end with WAVs on disk |
| 6 | Plugin Uploader | Auto-upload after stop |
| 7 | PWA wired to backend | Browser plays takes |
| 8 | Cloudflare quick tunnel | Phone hits laptop |
| 9 | Opus transcoding on backend | 10× smaller streaming files |
| 10 | Single-origin PWA | Backend serves built PWA + API |
| 11 | Storage adapter | Pluggable R2 ↔ Supabase Storage ↔ local |
| 12 | Editable take labels | Renamable in PWA |
| 13 | A/B player mode | Mobile UX moat — swap with playback continuity |
| 14 | Supabase Storage | Cloud audio (later replaced by R2) |
| 15 | R2 with multipart upload | Free-egress streaming, big files work |
| 16 | DB adapter (Postgres) | Metadata moves to Supabase Postgres |
| 17 | Magic-link auth in PWA | Real accounts |
| 18 | Plugin device-link auth | Sign in via QR + 6-digit code |
| 19 | RLS + privacy fix | Per-user data, no leak between users |
| 20 | Plugin polish | Take list, UTF-8, level meter, rec button |
| 21 | Render Free deploy | Backend cloud-hosted (laptop-off works) |
| 22 | Custom domain `app.earshot.cc` | TLS via Render |
| 23 | Multipart direct-to-R2 from plugin | Solves Render Free's 100s timeout |
| 24 | Auth persistence | Machine-wide auth.json, sign in once |
| 25 | Plugin project list dropdown | Switch project from VST UI |
| 26 | Share tokens + comments with timestamps | Public-link sharing, leave comments |
| 27 | Free tier soft cap (3 projects) | First monetization gate |
| 28 | Collaborators by email | Project-wide invite + claim-on-signup |
| 29 | Shared-with-me inbox | Library shows takes others shared with you |
| 30 | Branded email + Resend | noreply@earshot.cc actually sends |
| 31 | LemonSqueezy Pro tier | $5/mo subscription via merchant of record |
| 32 | Webhook tier-sync (just fixed) | Auto-flip profile.tier on payment |
| 33 | Owner-only invite UI | Collaborators can't invite more |

## Known bugs / unfinished pieces

Look for these in the git log if a fix is needed.

- ☐ Webhook just fixed today — needs verification on next test
  checkout. Cards: LS test card `4242 4242 4242 4242`.
- ☐ "Two-track upload" (Opus first, WAV later) — user's idea, parked
  for future. Would solve slow-uplink frustration.
- ☐ Waveform player UI — not started, in Batch D.
- ☐ Landing page at `earshot.cc/` — not started, in Batch D.
- ☐ Branded affiliate redirect `earshot.cc/r/<handle>` — short
  redirect route to drop in.
- ☐ Resend custom SMTP for Supabase magic-link emails — currently
  uses Supabase's default sender. Switching gives branded auth
  emails too.
- ☐ Tier flip not always immediate — webhook arrives within seconds
  of payment, but PWA polls only every 3s for 30s after redirect.
  Fine for now.
- ☐ Two-take same slug across owners: project naming collisions
  not handled in URL. Edge case.

## Keys still pending rotation

The user pasted these in chat over time. Should all be rotated after
final setup:

- GitHub PAT (`ghp_flBh…`)
- Render API key (`rnd_ITv…`)
- R2 Secret Access Key
- Supabase service key
- Resend API key (`re_7XW…`)
- LemonSqueezy API key (long JWT)
- LemonSqueezy webhook secret (`kjshfjh…` — weak, definitely regenerate)

## How to continue in a new session

Two options:

### Option A — fresh chat with this doc

Open a new chat, attach or paste the path to this file, say:
> "Read docs/HANDOFF.md before you do anything. Then I want to <next task>."

The new assistant will read the doc, understand the architecture, and
pick up where the last session ended.

### Option B — persistent session prompt

Keep a single saved prompt the user uses each session:

> "I'm continuing work on Earshot. The full project state is in
> docs/HANDOFF.md in the repo at /Users/mazhar/Desktop/Misc/Claude
> Projects/AbletonPlugin. Read it first. Then: <task>."

### What to expect from a fresh session

- New chats don't have the running tool MCPs (Render, Supabase, LS)
  immediately — they activate when needed. The user may need to
  re-share credentials or re-authorize.
- A new session won't remember bug-fix decisions verbatim. Refer it
  back to git log (`git log --oneline -30`) for recent context.
- The plan and CLOUD.md are also useful reference.

## What's still to build (priority order)

1. **Batch D — presentation:**
   - Landing page at `earshot.cc/`
   - Waveform scrubber in mobile player
   - Affiliate hub copy (in `docs/affiliate-hub-copy.md`)
2. **Polish for launch:**
   - Branded Supabase magic-link emails (via custom SMTP = Resend)
   - `earshot.cc/r/<handle>` short-link redirect for affiliates
   - Switch Render from Free → Starter ($7/mo) before public users
   - 30-day auto-archival of free-tier takes (background job)
3. **Two-track upload** — Opus first, WAV in background. Best UX win
   left on the table.
4. **Plugin distribution:**
   - Signed + notarized `.pkg` for macOS (needs $99/yr Apple Developer)
   - Signed `.msi` for Windows
   - Sparkle / WinSparkle auto-update

## Useful commands

```bash
# Build plugin
cd plugin && cmake --build build --config Debug --target Earshot_VST3

# Build + test PWA locally against prod backend
cd web && VITE_API_BASE=https://app.earshot.cc npm run dev

# Tail Render logs (need RENDER_API_KEY env)
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=tea-d8rucamgvqtc73fic5sg&resource=srv-d8s02hb6sc1c73bs9e50&startTime=$(date -u -v -30M +%Y-%m-%dT%H:%M:%SZ)&limit=200"

# Trigger Render deploy
curl -s -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  https://api.render.com/v1/services/srv-d8s02hb6sc1c73bs9e50/deploys -d '{}'

# List R2 contents
node --env-file=backend/.env -e "
import('./backend/src/storage.js').then(async ({getStorage}) => {
  const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const c = new S3Client({region:'auto',
    endpoint:'https://'+process.env.R2_ACCOUNT_ID+'.r2.cloudflarestorage.com',
    credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,
                 secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
  const r = await c.send(new ListObjectsV2Command({Bucket:process.env.R2_BUCKET}));
  console.log((r.Contents||[]).map(o=>o.Key).join('\n'));
});
"
```

## End

If you read this file as a new session: **don't make changes yet**.
Summarize back to the user what you understood so they can confirm
context, then ask what specific task to tackle. Don't reinvent designs
that are already in place.
