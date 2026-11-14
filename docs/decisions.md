# Decisions

## D-001 — Attach to Chrome over CDP, don't launch it (2026-11-11)
The user starts Chrome (`npm run chrome`); the script attaches with `connectOverCDP`.
**Why:** no automation flags or `navigator.webdriver`, the real fingerprint, and the user can browse the same profile by hand and step in on checkpoints.
**Cost:** Chrome must already be open, so runs aren't unattended. If that's needed later, add a `launchPersistentContext` mode (`channel: 'chrome'`, headed, `ignoreDefaultArgs: ['--enable-automation']`) on the same profile.

## D-002 — Dedicated profile outside the repo (2026-11-11)
Profile at `%LOCALAPPDATA%\pst\chrome-profile` on Windows, `~/Library/Application Support/pst/chrome-profile` on macOS, `~/.local/share/pst/chrome-profile` on Linux (`src/platform.js`).
**Why:** Chrome 136+ ignores `--remote-debugging-port` on the default profile; keeping it outside the repo means cookies can't be committed.

## D-003 — Playwright on real Chrome, no Camoufox or stealth plugins (2026-11-11)
**Why:** for one logged-in account, a stable device identity and human-paced behavior matter more than fingerprint spoofing. Camoufox rotates fingerprints, which looks like a new device each run. `playwright-core` is used since no bundled browser is needed.

## D-004 — Plain JS (ESM), no build step (2026-11-11)
**Why:** boilerplate stays small; types come from JSDoc. Revisit if the code grows.

## D-005 — JSON files in `output/` as the store (2026-11-14)
One folder per watch: `watch.json`, `listings.json` and `alertState.json` (written atomically: temp file, then rename), plus `passes`, `events` and `alerts` as JSONL.
**Why:** a watch holds tens to hundreds of listings, so a database isn't needed. Files are easy to inspect, and `output/` is already gitignored. Revisit if a watch passes a few thousand listings.

## D-006 — Watcher and UI are separate processes; UI is local and nearly read-only (2026-11-14)
`npm run watch` drives Facebook. `npm run ui` serves a page on `127.0.0.1` that reads the store; its only write is alert read-marks. It checks Host and Origin and sets a strict CSP.
**Why:** the browser page can never trigger Facebook visits, and other sites or local network devices can't reach or drive it. Phone or LAN access would need auth first.

## D-007 — Persisted daily visit cap, searches reserved first (2026-11-14)
`MAX_DAILY_VISITS` (default 60) is counted in `output/visits-<date>.json` by `Facebook.open()`, on top of the per-run budget. A watch starts only if its searches fit in what's left today. Each pass's details use `left − remaining searches`.
**Why:** watches spread many visits over hours, which the per-run budget doesn't bound. Reserving searches means details can't starve later checks.

## D-008 — Alerts as local desktop notifications from the watcher (2026-11-14)
Rules are given with `--alert` and fire when they become true for a listing, or when the price changes while they still hold. Alerts go to the UI, the console, and an OS notification: `osascript` on macOS, a PowerShell toast on Windows, `notify-send` on Linux. Text is passed as arguments or environment variables, never spliced into a script. At most 3 notifications per pass.
**Why:** this works with the UI closed and without sending listing data to an outside service. Phone alerts are opt-in for later.

## D-009 — Build offline first, tune live with the user after (2026-11-14)
The multi-agent build uses fakes for the page, clock, notifications and spawn. No agent opens Facebook. Selectors in `src/fb.js` start as marked best guesses (`// TUNE LIVE`). Pasig's location value and the radius param are found live with the user afterwards (`npm run market -- --raw`).
**Why:** automated agents hitting a real account adds ban risk and can't clear checkpoints. Only the user can watch a live run.
