# Product Hunt Launch — Screen Recorder

## Name
Screen Recorder — the Loom replacement you buy once

## Tagline (60 chars)
Record screen + mic locally. Export MP4/GIF. $29, forever.
<!-- 58 chars -->

## Description (260 chars)
A local-first screen recorder for people tired of renting Loom. Pick a screen or window, toggle your mic, record with a floating timer, and export watermark-free MP4 or optimized GIF. Everything stays on your disk. Pay $29 once — no cloud, no account, no limits.
<!-- 260 chars -->

## Full description

Screen Recorder is a desktop app (Windows-first, Electron) that does the one thing most people actually use Loom for — recording their screen — without the $15/month toll or the part where your videos live on someone else's servers.

**What it does:**
- Source picker with live thumbnails: record any screen or single window
- One-toggle microphone, mixed with system audio into a clean single track
- Floating always-on-top recording pill with timer + stop button, so the app itself stays out of your shot
- Auto-saves every recording to your local Videos folder with generated thumbnails
- In-app library and player — scrub, review, delete
- Export to MP4 (H.264, plays everywhere) or properly optimized GIF (two-pass palette — small files that don't look like 2009)
- Trim start/end before exporting
- Zero telemetry, zero network calls, zero accounts

**What it costs:** $29. Once. The source is MIT on GitHub if you'd rather build it yourself — the purchase is the 1-click installer plus supporting an indie dev.

**Who it's for:** tutorial makers, devs recording bug reports, course creators, anyone who sends "here, watch this" videos and doesn't need a corporate video cloud attached to them.

## Maker first comment

Hey PH 👋

I built this because I got tired of paying $15/mo for Loom when 95% of what I do is: record screen → send file. That's $180 a year for videos that don't even live on my machine — they live on Loom's servers, behind Loom's links, subject to Loom's plan limits and watermarks.

So I made the boring, honest version: a recorder that saves a real file to a real folder on your real computer. MP4 for sharing, two-pass optimized GIFs for bug reports and README demos, trim built in. No account. No upload. It literally cannot phone home — there are no network calls in the code, which you can check, because it's MIT on GitHub.

The $29 is for the 1-click installer and to keep me shipping. If you're technical, `npm i && npm start` works and I'm genuinely fine with that.

Would love feedback — especially on what export formats/presets you'd want next (webcam bubble overlay is the current front-runner).

## Gallery shots (5)

1. **Hero** — Record view: dark UI, grid of screen/window thumbnails, one selected with the indigo ring, red "Start recording" pill. Caption: "Pick a screen or window. Hit record."
2. **Recording in action** — desktop with the tiny floating pill (red dot, timer, stop button) in the corner over a code editor. Caption: "A timer, not a takeover."
3. **Library** — grid of recordings with thumbnails, sizes, dates. Caption: "Your videos, on your disk. Not ours."
4. **Export modal** — player, trim fields, MP4/GIF buttons, progress bar at 64%. Caption: "MP4 or optimized GIF, with trim. No watermark, ever."
5. **Comparison card** — Screen Recorder $29-once vs Loom $180/yr table from the README. Caption: "Pays for itself before your Loom trial ends."
