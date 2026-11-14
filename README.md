# pst

Drive a logged-in Facebook account from Node with Playwright, by attaching over CDP to a real Chrome window on a dedicated profile.

> Meta's terms ban automated access. The account is what's at risk: keep volume low and don't use an account you can't afford to lose.

## How it works

```
npm run chrome  ──► real Chrome, dedicated profile, --remote-debugging-port=9222
                         ▲   (you log in by hand, browse by hand now and then)
                         │
npm start       ──► Playwright connectOverCDP ──► opens its own tab, does the work, closes the tab
```

- **You launch Chrome, the script attaches.** No `--enable-automation` flag, no `navigator.webdriver`, your real fingerprint.
- **Dedicated profile** (Windows `%LOCALAPPDATA%\pst\chrome-profile`, macOS `~/Library/Application Support/pst/chrome-profile`). Since Chrome 136 the debugging port is ignored on your default profile, so this one is separate.
- **Login is never automated.** You log in once by hand (with 2FA). The cookies live in the profile.
- **The script hands control back** when Facebook shows a checkpoint or login screen, and waits for you to clear it.

## Setup

Works on Windows and macOS (Linux too).

```sh
npm install
cp .env.example .env        # optional; defaults work (Windows: copy .env.example .env)
npm run chrome              # opens Chrome on facebook.com
```

Log in to Facebook in that window. Then:

```sh
npm start                   # attach, check login, scroll the feed
npm start -- <groupId>      # also open a group and print a few posts
npm test                    # unit tests (no browser, no .env)
```

Leave Chrome open between runs. Close it when you're done for the day, because while it's open any program on this computer can control it through port 9222.

## Marketplace watch

Search Marketplace, re-check the results on a schedule, track what changed (new listings, price changes, sold, missing), raise alerts, and show it all on a local page. Plan: `docs/plans/marketplace-watch.md`. Spec: `docs/plans/mw-contracts.md`.

> **Built offline, not yet tuned on the live page.** The selectors in `src/fb.js` marked `// TUNE LIVE` are best guesses. Do the live step below before trusting a watch.

```sh
npm run market -- "test phone 128gb"                 # one pass: prints the search URL, area, parsed listings, 1 detail
npm run market -- "test phone 128gb" --raw           # also prints the raw text of the first 3 cards (for tuning)
npm run watch -- "test phone 128gb" --times 6 --every 30m --alert "price<25000"
npm run watch -- "test phone 128gb" --until 18:00 --max-price 30000 --alert "new & -keyword:icloud"
npm run ui                                           # local page at http://127.0.0.1:5173/
```

The watch runs in the foreground. Ctrl+C stops it after the current step, and a second Ctrl+C quits at once. Only one watch runs at a time (lock file in `output/watches/`). The UI is a separate process that only reads the store. Its one write is marking alerts as read, so the page can never cause a Facebook visit.

**Watch options:** `--times N` (1–48, default 4, or worked out from `--until`), `--every 30m` (minimum 10m, ±20% jitter), `--until 18:00` or an ISO date-time, `--min-price N` / `--max-price N` (whole pesos), `--location SLUG`, `--radius KM`, `--days N`, `--max-listings N` (1–100, default 40), `--details N` (detail pages per pass, 0–20, default 5), `--alert "RULE"` (repeatable), `--no-desktop`. Use `-h` for help. Passes inside quiet hours move to the end of the quiet window.

### Alert rules

A rule is one or more clauses joined by `&`, and all of them must hold. Amounts are whole units.

| Clause | True when |
|---|---|
| `price<N`, `price<=N` | The current price is under / at most N (`Free` counts as 0) |
| `drop>=N` | The price is at least N below the price when first seen |
| `drop>=P%` | The price is at least P% below the price when first seen |
| `new` | The listing first appeared in this pass (never on pass 1, the baseline) |
| `keyword:<text>` | The title or description contains the text (case- and accent-insensitive). Quote multi-word text: `keyword:"256 gb"` |
| `-keyword:<text>` | The title and description don't contain it |

A rule fires once when it becomes true for a listing. It fires again if the price changes while the rule stays true, or if the rule turns false and then true again. Sold, pending and missing listings never alert. Alerts go to the UI (with an unread count), the console, and a desktop notification (macOS `osascript`, Windows toast, Linux `notify-send`; at most 3 per pass). Bad rules are rejected before any visit.

### Storage

Everything is JSON under `output/` (git-ignored):
- `output/watches/<id>/`: `watch.json`, `listings.json`, `passes.jsonl`, `events.jsonl`, `alerts.jsonl`, `alertState.json`, `alerts-read.json`;
- `output/visits-YYYY-MM-DD.json`: the daily visit counter.

### Live step — done 2026-11-14 (manual, with the user watching)

- [x] `npm run chrome` and log in by hand.
- [x] `npm run market -- "<query>" --raw`. Parsed listings match the page.
- [x] Pasig + 6 km read back from the results page; `radius` is honored. `--location` pins an area per search.
- [x] Card parsing tuned: the `Just listed` badge is skipped, title and place are read from the right lines.
- [x] Detail parsing tuned: title (visible `h1`), price, description, seller, posted time and condition come from the
      page text by label, not class names.
- [x] First real watch: `npm run watch -- "monitor 27"` (4 passes), checked in `npm run ui`.

Still open:

- [ ] `npm start` and `npm start -- <groupId>` smoke run (page and group feeds).
- [ ] Tune the older `readPosts` selectors (author, time, link, text).

## Layout

| File | What it does |
|---|---|
| `scripts/chrome.js` | Finds Chrome and starts it with the port and profile |
| `src/platform.js` | Per-OS Chrome locations and default profile dir |
| `src/config.js` | Reads `.env` (port, profile dir, limits, quiet hours) |
| `src/browser.js` | `attach()`: connects over CDP, opens a tab, `detach()` closes only that tab |
| `src/human.js` | Random pauses, uneven scrolling, mouse-moved clicks, per-key typing, quiet hours |
| `src/guard.js` | Checkpoint/login detection and wait, per-run visit budget, daily visit cap |
| `src/fb.js` | Facebook navigation, including Marketplace search, cards and detail pages; all selectors live here |
| `src/market/parse.js` | Card, price and detail parsing (pure) |
| `src/watch/diff.js` | Tracks listings between passes, emits events, orders the details queue (pure) |
| `src/alerts/rules.js` | Alert rule parser, evaluation and firing state (pure) |
| `src/alerts/notify.js` | Desktop notifications without a shell (titles passed as arguments or env) |
| `src/watch/store.js` | JSON store under `output/watches/`, lock file |
| `src/watch/args.js`, `src/watch/runner.js` | Watch arguments and the pass loop |
| `src/watch.js`, `src/market.js` | `npm run watch` and `npm run market` |
| `src/server.js`, `public/` | `npm run ui`: local read-only page on 127.0.0.1 |
| `src/index.js` | Example run |

## Safe-use rules built in

- Visit budget per run (`MAX_PAGE_VISITS`, default 15), plus a daily cap across all runs (`MAX_DAILY_VISITS`, default 60). A watch reserves visits for its searches first, and details use what's left.
- 2.5 to 7 s random pause after every page load.
- Won't run during quiet hours (default 01:00 to 07:00).
- Same machine, same home IP, same profile every time. Don't add proxies.

## `.env` keys

All optional (see `.env.example`):
- Existing: `CDP_PORT`, `CHROME_PROFILE_DIR`, `CHROME_PATH`, `MAX_PAGE_VISITS`, `MIN_DELAY_MS`, `MAX_DELAY_MS`, `QUIET_START_HOUR`, `QUIET_END_HOUR`.
- New for the Marketplace watch:
  - `MAX_DAILY_VISITS` (60): visits per local day across all runs.
  - `UI_PORT` (5173): local UI port, 127.0.0.1 only.
  - `MARKET_LOCATION` (empty, meaning your profile's location): location slug or id; Pasig's is set after the live step.
  - `MARKET_RADIUS_KM` (6): search radius.
  - `MARKET_CURRENCY` (PHP): currency when no symbol is shown.
  - `OUTPUT_DIR` (`output/`): where watches and the visit counter live.
