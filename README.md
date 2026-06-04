# Earshot

> Your studio, in your pocket.

A VST3 plugin for Ableton (and any DAW) that streams your work-in-progress to
your phone — live while you're producing, and as versioned snapshots you can
listen to anywhere, even after Ableton is closed.

See [docs/plan.md](docs/plan.md) for the full design.

## Layout

```
plugin/        JUCE VST3 (C++)
  Source/      PluginProcessor, PluginEditor, BrandLookAndFeel
  CMakeLists.txt
web/           Mobile PWA (Vite + React + TypeScript)
  src/screens/ Library, Project, SignIn
backend/       (TBD) Supabase + LiveKit Cloud config
third_party/
  JUCE/        Submodule, pinned to 7.0.12
docs/
```

## Dev — plugin

Requires CMake 3.22+ and Xcode (CLI tools sufficient on macOS).

```bash
cd plugin
cmake -B build -G Xcode
cmake --build build --config Debug --target Earshot_VST3
```

The build installs `Earshot.vst3` into
`~/Library/Audio/Plug-Ins/VST3/`. Restart Ableton or rescan plugins.

## Dev — PWA

Requires Node 20+.

```bash
cd web
npm install
npm run dev   # http://localhost:5173
```

## Status

MVP scaffold:

- [x] VST3 builds and loads in Ableton with brand UI
- [x] PWA builds with manifest + service worker
- [ ] Audio tap → Opus encode → WebRTC live publish
- [ ] Real-time snapshot capture + upload
- [ ] Account auth (Supabase magic link)
- [ ] Live relay (LiveKit Cloud)
- [ ] Snapshot storage (S3/R2)
```
