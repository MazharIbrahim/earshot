# Ableton Mobile Preview Plugin — Plan

## Context

While producing in Ableton, you want to listen to in-progress versions of your
track on your phone without exporting and AirDropping a file every time.
Requirements you confirmed:

- VST3 plugin (works in Ableton on Mac + Windows, and in other DAWs as a bonus).
- Stereo master only.
- Reliable, good sound quality, user-friendly.
- Accessible **from anywhere** (not just LAN) via a user account.
- Available on mobile **even after Ableton is closed**.

Key constraint: a VST3 plugin can only see audio that flows through it in real
time. It cannot drive Ableton's offline render. So "snapshots" of the track are
captured during a real-time playback pass.

## Design overview

One product, two modes:

1. **Live preview** — when Ableton is open and playing, your phone hears the
   master bus in near-real-time (WebRTC, ~300–500 ms).
2. **Snapshot library** — every play-through is automatically captured, encoded,
   and uploaded to your cloud account as a versioned take. Mobile can play any
   past version anytime, even with Ableton closed.

Mobile is a **Progressive Web App (PWA)** — a website you open in Safari/Chrome
and optionally "Add to Home Screen." No App Store, no installer, works on iOS
and Android with the same code. This is the "no app" path you asked for, with
the option to feel app-like.

## Components

### 1. VST3 plugin (JUCE / C++)

Sits on the master bus. Responsibilities:

- **Audio tap**: pulls stereo float buffers from `processBlock`, resamples to
  48 kHz, encodes to **Opus** at ~128 kbps (excellent quality, low CPU,
  WebRTC-native).
- **Live mode**: pushes encoded Opus frames over a secure WebSocket (WSS) to
  the cloud ingest endpoint. A "Live" indicator + listener count shows in the
  plugin UI.
- **Snapshot mode**: when the host's transport starts, begins buffering the
  captured PCM to a local temp file. On transport stop (or "Save snapshot"
  button), encodes the captured audio to two formats and uploads:
  - **AAC 256 kbps** (or Opus 192 kbps) for streaming playback.
  - **FLAC** as a lossless archival copy (optional, behind a toggle).
- **Auth**: device-link flow. The plugin shows a 6-digit code; user opens the
  web app on phone or computer, signs in, and enters the code to link the
  plugin to their account. JWT stored in the plugin's settings dir.
- **UI**: account status, current project name (editable, defaults to Ableton
  set name when available via host metadata), live indicator, recent snapshots
  list with delete/rename, QR code for the mobile URL.

Built with **JUCE** — handles VST3 packaging, GUI, file I/O, and cross-platform
build (Mac/Win/Linux). Use `libopus` for encoding and `libdatachannel` (or a
minimal WebRTC client) for the live path; plain `libcurl` for snapshot uploads.

### 2. Backend (cloud)

- **Auth service**: email + magic-link sign-in (no passwords to manage). Issues
  JWTs to plugin and mobile clients.
- **Live relay**: a WebRTC SFU. Easiest path is a managed service —
  **LiveKit Cloud** or **Cloudflare Realtime** — so we don't run our own TURN
  servers. The plugin publishes one audio track per project; mobile subscribes.
- **Snapshot storage**: object storage (S3 / R2) for audio files, Postgres for
  metadata (user, project, version, timestamp, duration, notes).
- **API**: small REST/GraphQL surface — list projects, list versions, get
  signed playback URL, delete version, rename.

A managed stack (Supabase for auth + Postgres + storage, plus LiveKit Cloud for
the live relay) covers all of this without writing much backend code. That's
the recommended starting point.

### 3. Mobile web app (PWA)

- Framework: any modern stack (React + Vite is fine). HTML5 `<audio>` for
  snapshot playback, WebRTC `RTCPeerConnection` for live.
- Screens: sign in → project list → project detail (live banner if active,
  list of versions below) → player with scrubber, version notes, share link.
- **PWA manifest + service worker** so it installs to the home screen, opens
  full-screen, and caches recently-played snapshots for offline listening on
  the subway.
- iOS note: autoplay requires a user tap on the first session — that's a
  one-time "Tap to listen" button, then it streams normally.

## Why these choices

- **VST3 + JUCE**: cross-platform with one codebase, mature, and JUCE handles
  the host integration headaches. Ableton on Mac/Win is the target; Linux works
  for free as a side benefit.
- **Opus for live, AAC for snapshots**: Opus is the WebRTC-native codec and
  sounds great at 128 kbps. AAC for snapshots gives universal browser support
  including iOS Safari.
- **WebRTC for live**: sub-second latency over the public internet. HTTP
  streaming (HLS) would be 5–15s, which feels broken when you tweak a knob and
  wait to hear it.
- **Managed SFU (LiveKit/Cloudflare)**: running your own TURN server for NAT
  traversal is a sinkhole. Pay someone else for it.
- **Real-time capture for snapshots**: only path a VST3 has. UX is "hit play
  once, it's on your phone forever" — still way better than File → Export →
  AirDrop every time.
- **PWA over native app**: one codebase, no App Store review, works on iOS and
  Android, installable. Matches your "simplest possible, no app ideally"
  preference while still feeling like an app.

## Critical files / modules to build

Greenfield project. Suggested layout:

- `plugin/` — JUCE VST3 project
  - `Source/PluginProcessor.cpp` — audio tap, Opus encode, ring buffer
  - `Source/LiveStreamer.cpp` — WSS / WebRTC publisher
  - `Source/SnapshotRecorder.cpp` — PCM buffer → AAC/FLAC → upload
  - `Source/Auth.cpp` — device-link flow, JWT storage
  - `Source/PluginEditor.cpp` — UI (status, QR, snapshot list)
- `backend/` — managed services config + small API
  - Supabase schema (users, projects, versions)
  - LiveKit room provisioning hooks
  - Signed-URL issuance for snapshot playback
- `web/` — PWA (React + Vite)
  - Auth, project list, player, PWA manifest, service worker

## Verification

End-to-end test you can run yourself, in order:

1. Build the VST3, drop it on Ableton's master, link it to a test account.
2. Open the PWA on your phone, sign in, confirm the test project appears.
3. Hit play in Ableton → phone shows "Live" within ~2 s and audio is audible
   with <1 s latency. Tweak a filter → confirm the change reaches the phone
   quickly.
4. Stop transport → within ~10 s a new "Version" appears in the phone list.
5. Quit Ableton entirely → phone can still open and play that version.
6. Turn phone Wi-Fi off, switch to cellular → version still plays (proves it's
   cloud-hosted, not LAN).
7. Force-quit the PWA, reopen offline → recently-played version still plays
   from service-worker cache.

## Brand & product identity

### Name

**Recommended: Earshot.**

- One word, music-adjacent ("within earshot"), communicates the value: hear
  your track wherever you are.
- Producer-friendly, doesn't sound corporate, easy to say.
- Reads well as a verb in UI ("Earshot this take," "Send to Earshot").
- Backup options if the name is taken: **Stash** (your stash of WIPs),
  **Tape** (sending tapes home from the studio), **Cue** (short, musical).

Tagline candidates:
- "Your studio, in your pocket."
- "Hear it before you bounce it."
- "WIPs, anywhere."

### Who we're designing for

Bedroom and pro producers using Ableton. They live in dark UIs, value precise
tactile tools (Teenage Engineering, Arturia, Splice, Output), and are
allergic to anything that feels like enterprise SaaS. The identity should feel
like a piece of studio gear, not a startup product.

### Visual identity

- **Type**: a precise grotesque or mono. Söhne Mono / JetBrains Mono / Inter
  Tight. Numerals are tabular — timestamps and durations line up cleanly.
- **Palette**: deep near-black background (`#0E0E10`), warm off-white text
  (`#EDE9E2`), single accent — recommend a warm signal amber (`#FFB347`) that
  pops against dark Ableton themes and looks great glowing on a phone OLED.
- **Logo mark**: a simple geometric "ear curve" or a single sound-wave arc
  inside a circle — works as a 16px favicon and a 1024px app icon.
- **Voice**: short, lowercase, direct. "live now." "5 takes." "tap to listen."
  No exclamation marks, no emoji in product copy.

### What it looks like in the DAW

Ableton plugin windows are tight, so the layout is one narrow column,
compact, dark:

- Top: project name (editable inline) + tiny "Earshot" wordmark.
- Live indicator: amber dot + "live · 1 listener" when streaming.
- Big primary button: **Snapshot** (captures the next play-through).
- Below: last 3 takes with duration + relative time ("2m ago"), tap to
  rename, swipe to delete.
- Footer: account chip, QR code button (taps to expand a QR linking to the
  mobile URL).

No tabs, no settings page in the main view — preferences live in a small gear
modal.

### What it looks like on mobile

The PWA should feel like a beautiful music player, not a dashboard:

- **Home**: list of projects as large cards. Each card shows an
  auto-generated waveform/gradient seeded from the project name (so every
  project has a recognizable "cover" without the producer doing anything).
  Live projects pulse amber.
- **Project view**: cover at the top, big play button, version list below
  ("v12 · 3 min ago · 4:21"). Tap a version to play; long-press to rename or
  share.
- **Player**: full-screen, big scrubber, waveform, version switcher swipes
  left/right between takes — so you can A/B yesterday vs today with a flick.
- **Live mode**: when Ableton is publishing, a banner slides down from the
  top — "live from <project>" — tap to listen.

PWA installs to home screen with a black app icon and amber mark. Opens
full-screen, no browser chrome.

### Distribution (post-MVP, but worth designing for now)

We're not monetizing yet — the goal is to get producers using it.

- **Website**: `earshot.fm` (or similar). Single landing page: a 20-second
  video of the live preview working, a download button, a "What's on your
  phone" demo. No pricing page yet.
- **Plugin downloads**: signed + notarized installers hosted directly.
  - Mac: `.pkg` installer placing the VST3 in `~/Library/Audio/Plug-Ins/VST3`.
    Apple Developer ID signed + notarized so Gatekeeper doesn't scare users.
  - Windows: signed `.exe` or `.msi` placing the VST3 in
    `C:\Program Files\Common Files\VST3`.
- **Auto-update**: Sparkle (Mac) and WinSparkle (Win). Plugin checks weekly,
  prompts user. Critical for a young product that ships fixes often.
- **Mobile**: no install — URL printed in the plugin, QR code, or sent via
  the magic-link email. PWA prompt suggests "Add to Home Screen" on second
  visit.
- **Onboarding**: closed beta with invite codes for the first ~200 users.
  Discord for feedback. After stability, open public beta — still free.
- **Distribution channels later**: KVR Audio listing, Splice plugin
  directory, a "Tested in Ableton" badge from Ableton's partner program.
  Reach out to a handful of well-followed producers on YouTube/TikTok for
  organic demos once the experience is polished.

## Scope notes / explicitly out

- Per-track previews, multi-listener collab sessions, comments/timestamps on
  versions — all natural follow-ups, not v1.
- Driving Ableton's offline render — not possible from a VST. If you ever want
  faster-than-realtime snapshot capture, that requires a Max for Live companion
  device using the Live API, which is a separate effort.
- Android/iOS native apps — skipped in favor of the PWA.
