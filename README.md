# 🎥 Screen Recorder

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)]()
[![Local First](https://img.shields.io/badge/100%25-local-red.svg)]()

**The Loom replacement you buy once.** Record your screen and mic, save everything locally, export MP4 or GIF — no cloud, no monthly bill, no watermark, no upload limits. Your recordings live on *your* disk, not on someone else's server.

> **Pay once. Own it forever. No subscription.**

![Screenshot](docs/screenshot.png)

## ✨ Features

- **Source picker with live previews** — record any screen or individual window, thumbnails included
- **Microphone audio** — one toggle, mixed cleanly with system audio into a single track
- **Floating recording pill** — tiny always-on-top timer with a stop button, so your main window stays out of the shot
- **Local library** — every recording auto-saves to `Videos/Screen Recorder` with generated thumbnails, plays right in the app
- **MP4 export** — H.264 + faststart, plays everywhere, with live progress
- **Optimized GIF export** — proper two-pass palette generation (palettegen/paletteuse), not the muddy single-pass junk
- **Trim** — set start/end seconds before exporting, no separate editor needed
- **100% local** — zero telemetry, zero network calls, zero accounts

## 🚀 Quick start

```bash
git clone https://github.com/bensblueprints/screen-recorder
cd screen-recorder
npm i && npm start
```

Run the smoke test (synthesizes a test video and pushes it through the full MP4 + GIF pipeline):

```bash
npm test
```

Build the Windows installer:

```bash
npm run dist
```

## ☕ Skip the setup — get the 1-click installer

Don't want to touch a terminal? Grab the packaged installer (one-time purchase, free updates forever):

**→ [https://whop.com/onetime-suite](https://whop.com/onetime-suite)**

## 🥊 vs. Loom

| | **Screen Recorder** | Loom Business |
|---|---|---|
| Price | **$29 once** | $15/mo, forever ($180/yr) |
| Where videos live | **Your disk** | Their servers |
| Recording length | **Unlimited** | Limited by plan |
| Watermark | **Never** | On free tier |
| Works offline | **Yes** | No |
| Account required | **No** | Yes |
| MP4 + GIF export | **Built in** | GIF gated by plan |
| Your data mined for AI | **Impossible — it never leaves** | Read the ToS |

Loom is great for team clouds. If you just want to *record your screen and own the file* — that shouldn't cost $180 a year.

## 🛠 Tech stack

- **Electron** — main + preload + renderer, context isolation on
- **desktopCapturer + getDisplayMedia** — native screen/window capture with a custom picker
- **MediaRecorder (VP9/Opus)** — in-renderer recording, mic mixed via Web Audio `AudioContext`
- **ffmpeg-static** — bundled ffmpeg for MP4 (libx264), two-pass GIF, trims, thumbnails, and duration probing
- Plain HTML/CSS/JS renderer — no framework, boots instantly

## 📁 Where recordings go

`%USERPROFILE%\Videos\Screen Recorder` (or your platform's Videos folder). The app never writes anywhere else, and "Open recordings folder" is one click away.

## License

[MIT](LICENSE) © 2026 Ben (bensblueprints)
