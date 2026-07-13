# Launch Strategy — Bloom Recorder

## Positioning
"Pay once. Own it forever. No subscription." — the local-first Loom replacement for people who record tutorials, bug reports, and course content and just want the file. Loom charges monthly for videos that live on their servers; we charge $29 once for videos that live on yours.

## Target communities (rules-aware angles)

| Community | Angle | Rules notes |
|---|---|---|
| r/selfhosted | "Local-first Loom alternative — recordings never leave your machine" | Loves anti-cloud angle; open source first, mention paid installer only if asked. No pure self-promo without participation. |
| r/DataHoarder | "Your screen recordings shouldn't live on Loom's servers" — ownership angle | Lead with local storage/ownership, not price. |
| r/webdev + r/programming | "How I record bug-report GIFs: two-pass palettegen vs the muddy defaults" — technical write-up that features the tool | Both require substance-first posts; write the ffmpeg deep-dive, link repo at the end. |
| r/SideProject / r/indiehackers | Build story: "I replaced my Loom subscription with a weekend Electron app, then productized it" | Self-promo allowed; share revenue/journey details for engagement. |
| r/CourseCreators / r/Teachers | "Record unlimited-length lessons with no watermark or monthly fee" | Value-first: include a free workflow tip (trim + MP4 faststart for LMS uploads). |
| Hacker News | Show HN (below) | No marketing speak; lead with tech decisions, respond fast in comments. |

## Show HN draft

**Title:** Show HN: A local-first screen recorder — buy once, no cloud (Electron + ffmpeg)

**Body:**
I record a lot of tutorials and bug-report clips, and Loom's $15/mo felt absurd for "capture pixels, produce file." Also the files aren't really *mine* — they live behind Loom links, on Loom plans.

So I built a small Electron app: desktopCapturer + a custom source picker, MediaRecorder (VP9/Opus) in the renderer, mic mixed in with an AudioContext, and ffmpeg-static for the boring-but-important parts — H.264 MP4 with faststart, *two-pass* GIF (palettegen/paletteuse — the difference vs single-pass is dramatic), trims, thumbnails.

Everything is local: no accounts, no telemetry, no network calls at all. Source is MIT; I sell a $29 packaged installer for people who don't want to `npm i`.

Things I learned the hard way: MediaRecorder WebM has no duration metadata (probe with ffmpeg instead of trusting `video.duration === Infinity`), and Electron's `setDisplayMediaRequestHandler` is the clean modern way to route your own picker into `getDisplayMedia`.

Happy to answer anything about the capture pipeline.

## SEO keywords (10)
1. loom alternative one time purchase
2. screen recorder no subscription
3. local screen recorder windows
4. screen recorder no watermark free unlimited
5. record screen to gif windows
6. loom alternative without cloud
7. screen recording software one time payment
8. best screen recorder for tutorials
9. webm to mp4 screen recording
10. screen recorder for course creators

## AppSumo / PitchGround pitch

Screen Recorder is the anti-subscription answer to Loom: a polished, local-first desktop recorder that captures any screen or window with mic audio, auto-saves to a built-in library, and exports watermark-free MP4 or two-pass-optimized GIF with trim controls — all 100% offline, no account, no telemetry. Loom's cheapest paid plan is $180/year and keeps your videos on their servers; our lifetime deal gives your buyers the whole tool forever for less than two months of that. The MIT-licensed source doubles as proof there's no lock-in — the deal is the packaged 1-click installer plus lifetime updates. Perfect for the tutorial makers, support teams, and course creators who make up your core audience.

## Pricing math

- **Suggested price: $29 one-time** (launch: $19 early-bird).
- Loom Business: $15/mo → **pays for itself in under 2 months**; vs $180/yr that's an 84% first-year saving.
- Even vs Loom's $12.50/mo annual billing, breakeven is 2.3 months.
- Anchor line for all copy: "Loom rents you a recorder for $180/yr. This one costs $29, once, and the videos are actually yours."
