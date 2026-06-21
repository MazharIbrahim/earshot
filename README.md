# Earshot

> Your studio, in your pocket.

A VST3 plugin for Ableton Live (and any DAW) that records snapshots of your
in-progress tracks and streams them to your phone — for listening in the car,
on a walk, sharing with collaborators, or A/B-ing versions on a real sound
system. No app required on the phone: open a URL.

The product premise: **version history for your work-in-progress music**.

## How it works

```
┌─ Plugin (your DAW's master bus)
│   • Captures stereo audio on demand (REC armed → next play-through)
│   • Uploads WAV to backend on stop, with idempotency
│
├─ Backend (Node + Express)
│   • Transcodes WAV → Opus (~10x smaller, broad browser support)
│   • Pushes Opus to Cloudflare R2 (free egress, perfect for streaming)
│   • Stores metadata in Supabase Postgres
│
└─ PWA (mobile/desktop browser, no install)
    • Lists projects + takes
    • A/B player with sync-position swap between two takes
    • Editable labels per take
    • Share links (?t=<takeId>) that auto-play
    • Magic-link auth (per-user private libraries)
```

## Tech

- **Plugin:** JUCE 7.0.12, C++17, CMake. Builds VST3 + AU on macOS/Windows/Linux.
- **Backend:** Node 20, Express, ffmpeg (libopus), AWS S3 SDK (multipart uploads to R2).
- **PWA:** Vite + React + TypeScript, PWA manifest + service worker.
- **Storage:** Cloudflare R2 (audio), Supabase Postgres (metadata), Supabase Storage (avatars later).
- **Auth (in progress):** Supabase Auth, email magic links.

## Repo layout

```
plugin/        JUCE VST3 — C++
  Source/      PluginProcessor, PluginEditor, CaptureBuffer, TakeWriter,
               Uploader, HealthPoller, TakesPoller, brand UI, QR overlay
backend/       Node + Express
  src/         server, db (sqlite|supabase), storage (local|r2|supabase),
               transcode (ffmpeg), tunnel (cloudflared)
web/           Vite + React + TS PWA
  src/         api client, screens (Library, Project, SignIn), brand tokens
docs/          plan.md, CLOUD.md, supabase-schema.sql
third_party/
  JUCE/        submodule, pinned to 7.0.12
  qrcodegen/   vendored nayuki QR encoder (used for the plugin's QR modal)
```

## Quick start (development)

Requires Node 20+, CMake 3.22+, Xcode CLT (macOS) or MSVC (Windows), ffmpeg.

```bash
git clone --recursive https://github.com/MazharIbrahim/earshot.git
cd earshot

# Build plugin (installs to ~/Library/Audio/Plug-Ins/VST3 on macOS)
cd plugin
cmake -B build -G Xcode
cmake --build build --config Debug --target Earshot_VST3
cd ..

# Backend
cd backend
cp .env.example .env   # fill in R2 + Supabase credentials
npm install
npm start              # listens on http://localhost:8787

# PWA
cd ../web
npm install
npm run dev            # http://localhost:5173
```

## Status

Pre-launch. Core loop works end-to-end with cloud storage + database. Working
on: hosted backend, auth, distribution.

See [`docs/plan.md`](docs/plan.md) for the product roadmap and
[`docs/CLOUD.md`](docs/CLOUD.md) for cloud migration notes.

## License

MIT (see [LICENSE](LICENSE)).
