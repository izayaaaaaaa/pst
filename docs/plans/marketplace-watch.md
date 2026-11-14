# pst — Marketplace watch plan

## Goal
Search Facebook Marketplace for a product, re-check the results a number of times the user chooses, track what changes between checks (new listings, price changes, sold or gone), and show it all on a local web page.

A watch runs for a number of checks (passes) and/or until a set time, e.g. "6 checks, every 30 minutes" or "every 30 minutes until 18:00". It searches around Pasig City (6 km) by default, opens new listings for their details, and raises alerts on rules you set.

Agreed 2026-11-14: `--times` and `--until` both supported; details on; default location Pasig City within 6 km; UI on this machine only; alerts specced (section 5a).

## Status (2026-11-14)
- **Built offline** on branch `mw` (run in `mw-workflow.md`, spec in `mw-contracts.md`):
  - parsing, diff and details queue;
  - alert rules and desktop notifications;
  - daily cap, store and lock;
  - Marketplace methods in `src/fb.js`;
  - runner and the `watch` / `market` CLIs;
  - local UI.
  - 160 unit tests pass. Nothing has touched the live page yet.
- **Milestones:** the code for 2 (watch), 3 (alerts) and 4 (UI) is done and tested with fakes. Milestone 1's code is done too (`npm run market`, parsers).
- **Pending, live with the user:**
  - milestone 1's live step: Pasig's location value, whether `radius` works, tuning the `// TUNE LIVE` selectors, saving cleaned fixtures;
  - milestone 2's real 3-pass watch at 10m;
  - checking macOS notification permission on a real alert.
- Builder contract decisions are in `mw-contracts.md` §12.

## Constraints carried over
- Attach to the user's Chrome only (D-001). Chrome must stay open for the whole watch; each pass attaches, works in its own tab, and detaches.
- Every page load goes through `Facebook.open()`, so the visit budget, pauses and checkpoint wait apply.
- All Marketplace selectors live in `src/fb.js`.
- Quiet hours apply: a pass that falls inside them waits until they end.
- Plain JS, no build step (D-004), so no frontend framework or bundler.

## Overview

```
npm run watch -- "iphone 13" --every 30m --until 18:00 --max-price 30000 --alert "price<25000"
   │
   ├─ pass 1..N ──► attach ─► open search URL ─► scroll ─► read cards ─► detach
   │                                                          │
   │                         parse ─► diff ─► open details for new listings
   │                                                          │
   │                                      check alert rules ─► desktop notification + UI
   │                                                          │
   └────────────────────────────── write to output/watches/<id>/ (JSON)
                                                              ▲
npm run ui  ──► local server (127.0.0.1:5173) ── reads ───────┘
                    └─► static page in the browser: watches, listings, price history, events
```

The watcher and the UI are separate processes. The UI never drives Facebook in v1. It reads what the watcher wrote; its only write is marking alerts as read.

## 1. Inputs

CLI: `npm run watch -- <query> [options]`

| Option | Default | Meaning |
|---|---|---|
| `--times N` | 4 if `--until` isn't given | Number of passes (1–48) |
| `--until T` | none | Stop after this time: `18:00` (today, or tomorrow if already past) or an ISO date-time. With `--times` too, whichever comes first ends the watch |
| `--every D` | `30m` | Time between passes (`15m`, `1h`). Minimum 10m. ±20% random jitter |
| `--min-price`, `--max-price` | none | Price filter, passed in the search URL |
| `--location <slug\|id>` | Pasig City (`MARKET_LOCATION`) | Marketplace location slug or numeric id |
| `--radius <km>` | 6 (`MARKET_RADIUS_KM`) | Search radius |
| `--days <n>` | none | Only listings from the last n days (`daysSinceListed`) |
| `--max-listings M` | 40 | Stop reading cards after M per pass |
| `--details K` | 5 | Open up to K new listings per pass for full details (each costs one visit). `0` turns details off |
| `--alert <rule>` | none | Alert rule, repeatable. Syntax in section 5a |
| `--no-desktop` | | Alerts go to the UI only, with no desktop notification |

Validated into a `WatchSpec`:

```js
{ query, filters: { minPrice, maxPrice, location, radiusKm, daysSinceListed },
  times, until, everyMs, maxListings, detailsPerPass, alerts: [AlertRule], desktop }
```

`--until` alone sets `times` to the number of passes that fit before the deadline (`floor((until - now) / everyMs) + 1`), capped at 48 and at the daily visit cap. A pass that is due after `until` doesn't run. A deadline less than 10 minutes away, or in the past, is rejected.

### Default location: Pasig City, 6 km
- `.env`: `MARKET_LOCATION=<pasig slug or id>`, `MARKET_RADIUS_KM=6`, `MARKET_CURRENCY=PHP`.
- Facebook names Marketplace locations either by slug (`/marketplace/manila/`) or by a numeric place id. Pasig's value is found in milestone 1: set Pasig City in the location dialog by hand, then read it off the URL.
- Radius: check whether the search URL's `radius` param is honored. If it isn't, set 6 km once by hand in the location dialog (Facebook keeps it on the profile), and have each pass read the location chip on the results page and warn if it doesn't say Pasig and 6 km.

## 2. Search (one pass)

New `Facebook` methods in `src/fb.js`:

- `marketplaceSearch(query, filters)`: builds the URL and calls `open()`. One visit.
  `/marketplace/<location>/search?query=<q>&minPrice=&maxPrice=&daysSinceListed=&radius=&sortBy=creation_time_descend&exact=false`
  Without `--location`, use `/marketplace/search?...`, which takes the location from the profile.
- `readListingCards(max)`: scrolls the results with `scroll()` (no visit cost) until it has `max` unique cards, no new cards appear after 2 scrolls, or 10 scrolls are done. For each `a[href*="/marketplace/item/"]` it returns raw `{ href, text, img }`.
- `readListingDetail(id)`: opens `/marketplace/item/<id>`. One visit. Returns raw `{ text, sellerName, postedText, description, condition }`.

### Details for new listings (on by default)
- Each pass opens details for up to `K` (default 5) listings that don't have them yet, oldest-first in a queue.
- **Queue order:** listings that match an alert rule on their card first, then cheapest first. Pass 1 can find 40 listings, so with K=5 the backlog clears over the next passes instead of costing 40 visits at once.
- A listing that turns sold or missing leaves the queue.
- Opening the detail page makes `price`, `title` and `label` more reliable (same diff rules), and adds `description`, `sellerName`, `postedText` (for example "Listed 3 hours ago in Pasig") and `condition`.
- `--details 0` turns this off. Keyword alerts then only match titles.

Selectors are expected to need tuning on the live page. Milestone 1 covers that.

## 3. Parsing (pure, unit-tested)

`src/market/parse.js`. No Playwright here, only strings in and objects out.

- `itemIdFromHref(href)` → `"1234567890"`, or null.
- `parsePrice(text)` → `{ amount, currency, raw }`, with `amount` in minor units (cents/centavos).
  Handles `₱1,200`, `$50`, `PHP 1,200`, `Free` (amount 0), and discounted cards that show two prices (the first is current).
- `parseCard({ href, text, img })` → `Listing`, or null for sponsored or unparseable cards.
  The card text is usually price, title and location on separate lines. A "Sold" or "Pending" label sets the status.

```js
// Listing as seen in one pass
{ id, url, title, price: { amount, currency, raw }, location, image, label: null | 'sold' | 'pending' }
```

## 4. Tracking changes (pure, unit-tested)

`src/watch/diff.js`: `diff(known, seen, passNo, now)` → `{ known: updatedKnown, events }`.

`known` maps id → `TrackedListing`:

```js
{ id, url, title, image, location,
  price,                      // current
  priceHistory: [{ pass, at, amount }],   // a point only when the price changes
  firstSeen: { pass, at }, lastSeen: { pass, at },
  missedPasses: 0,
  status: 'active' | 'pending' | 'sold' | 'missing',
  detail: null | { description, sellerName, postedText } }
```

Rules:

| Situation | Event | Status |
|---|---|---|
| id not in `known` | `new` (none on pass 1, which sets the baseline) | active |
| price lower / higher | `price_drop` / `price_up`, with from and to | unchanged |
| title changed | `title_change` | unchanged |
| card labelled Sold / Pending | `sold` / `pending` | sold / pending |
| in `known` but not seen | none at first; `missedPasses += 1` | |
| missed 2 passes in a row | `missing` | missing |
| missing, then seen again | `back` | active |

A listing missing from the results doesn't prove it sold: search ranking moves and the card cap cuts results off. That's why `missing` waits 2 passes, and why a listing is only counted as unseen if it ranked in the top `maxListings` last time.

## 5. Watch runner

`src/watch/runner.js` + `src/watch.js` (CLI entry, `npm run watch`).

```
create watch (id = timestamp + query slug), status 'running', write watch.json
for pass in 1..times:
  wait until nextPassAt (skip forward past quiet hours)
  if until is set and now > until → stop
  if no daily visits left for the search → status 'stopped_budget', stop
  k = details allowed this pass (see daily cap below)
  attach
  budget = new Budget(1 + k)
  search → read cards → parse → diff → open details for up to k queued listings → re-diff those
  detach (always, in finally)
  evaluate alert rules → append alerts → send notifications
  append pass record and events, write listings, update watch.json
  nextPassAt = now + everyMs ± jitter
status 'done'
```

Failures:
- **Chrome not reachable:** record the pass as failed and carry on. Stop with `error` after 2 failed passes in a row.
- **Checkpoint not cleared in 10 min:** stop the watch at once (`stopped_checkpoint`), with no more passes.
- **Ctrl+C:** finish writing, set `stopped`, detach.
- **One watch at a time:** a lockfile (`output/watches/.lock`) stops a second watcher, so visits don't stack up.

### Daily visit cap (needed now, was "later")
The per-run budget (`MAX_PAGE_VISITS`) assumed one short run. A watch makes `times × (1 + K)` visits spread over hours, so add a cap that persists across runs:
- `MAX_DAILY_VISITS` in `.env`, default 60. Counter in `output/visits-<YYYY-MM-DD>.json`, bumped inside `Facebook.open()`.
- Searches come first, details get what's left over. At start, the watch is refused only if its searches alone (`times` visits) don't fit in what's left today. The message says how many passes would fit.
- Each pass, details allowed = `min(K, queued, visitsLeftToday − searchesStillToRun)`. That keeps a visit reserved for every remaining search, so details can never starve a later pass.
- Example: 60/day, every 30m from 10:00 until 18:00 = 17 passes. 17 visits are reserved for searches and up to 43 go to details, about 2–3 per pass after the first few.

## 5a. Alerts

Rules are set per watch when it starts (`--alert`, repeatable) and checked after every pass, once details are in.

### Rule syntax
A rule is one or more clauses joined by `&`. All clauses must hold.

| Clause | True when |
|---|---|
| `price<N`, `price<=N` | Current price is under / at most N (whole pesos, e.g. `price<25000`). `Free` counts as 0 |
| `drop>=N` | Price is at least N below the price when first seen |
| `drop>=P%` | Price is at least P% below the price when first seen |
| `new` | Listing first appeared in this pass (never on pass 1, which is the baseline) |
| `keyword:<text>` | Title or description contains the text (case- and accent-insensitive). Quote multi-word text: `keyword:"256 gb"` |
| `-keyword:<text>` | Title and description don't contain it (e.g. `-keyword:broken`) |

Examples:
- `--alert "price<25000"`: anything under ₱25,000, including what's already listed on pass 1.
- `--alert "new&price<28000&-keyword:icloud"`: a fresh listing under ₱28,000 that doesn't mention iCloud.
- `--alert "drop>=10%"`: a listing has come down 10% or more since it was first seen.

Sold, pending and missing listings are never alerted on. Parsing errors are reported at start, before any visit.

### When a rule fires
- Rules are checked for each (rule, listing) pair. A rule fires when it **becomes true** for a listing: first time seen matching, or a change that makes it match.
- If the rule stays true and the price **changes again** (e.g. a further drop), it fires again with the old and new price. Otherwise it stays quiet, so a listing that matches every pass alerts once.
- If the rule turns false and later true again, it fires again.
- Keyword clauses check the title until details are in, then the title and description. Listings whose card already matches a rule go to the front of the details queue (section 2).

### Where alerts go
1. **UI (always):** an unread count on every page, plus an alerts list (section 8).
2. **Desktop notification (default on, `--no-desktop` to turn off):** sent by the watcher, so it works with the UI closed.
   - **macOS:** `osascript` with the title and text passed as arguments (`on run argv`), never spliced into the script, so listing titles can't inject AppleScript. The first notification may ask for permission.
   - **Windows:** a PowerShell toast through the WinRT `ToastNotificationManager`, with the text passed in environment variables rather than spliced into the command.
   - **Linux:** `notify-send` if it's installed.
   - Anything else, or a failed notification: print to the console and ring the terminal bell. Failures never stop the watch.
   - At most 3 notifications per pass. With more alerts than that, the third one becomes a summary: "+4 more alerts for iphone 13, see the UI".
   - Text: title `pst · <query>`, body `₱24,500 (was ₱27,000) · iPhone 13 128GB · Pasig`.
3. **Console:** one line per alert in the watcher's output.

Phone alerts (Telegram etc.) are out of scope while the UI is machine-only. They would send listing data to an outside service, so they'd be opt-in.

### Data
```js
// AlertRule, parsed at start, stored in watch.json
{ id: 'r1', text: 'new&price<28000&-keyword:icloud',
  clauses: [{ type: 'new' }, { type: 'price', op: '<', amount: 2800000 }, { type: 'keyword', text: 'icloud', negate: true }] }

// Alert, one line in alerts.jsonl
{ id, at, pass, watchId, ruleId, ruleText, listingId, title, url,
  price, prevPrice, reason: 'price ₱24,500 < ₱25,000' }
```
Per-watch firing state (`alertState.json`: `{ "<ruleId>:<listingId>": { matched, lastPrice } }`) makes the "becomes true" and "price changed again" rules work across passes and restarts.

## 6. Storage

JSON files under `output/` (already gitignored). No database at this size.

```
output/watches/<id>/
  watch.json      WatchSpec + { id, createdAt, status, passesDone, nextPassAt, lastError }
  listings.json   { [id]: TrackedListing }   (rewritten each pass, via temp file + rename)
  passes.jsonl    { n, startedAt, endedAt, ok, error, seenIds, visits }
  events.jsonl    { at, pass, type, listingId, from, to }
  alerts.jsonl    Alert (section 5a), written by the watcher only
  alertState.json firing state per rule and listing
  alerts-read.json { readIds: [...] }, written by the UI only
```

Each file has a single writer: the watcher, or the UI for read marks. That avoids two processes rewriting the same file.

`src/watch/store.js` owns reading and writing. Writes are atomic (write `.tmp`, then rename), so the UI never reads half a file.

## 7. Local server

`src/server.js` (`npm run ui`), built on `node:http` with no dependencies. Binds to `127.0.0.1` only.

| Endpoint | Returns |
|---|---|
| `GET /api/watches` | List of watch summaries: query, status, passes done/total, next pass time, active count, count of new and price drops since start |
| `GET /api/watches/:id` | `watch.json` + `listings.json` (as an array) + pass records |
| `GET /api/watches/:id/events?since=<iso>` | Events, newest first |
| `GET /api/alerts?unread=1&watch=<id>` | Alerts across watches (or one watch), newest first, each with `read` |
| `POST /api/alerts/read` | Body `{ ids: [...] }` or `{ watch: id, all: true }`. Adds to `alerts-read.json`. The only write endpoint |
| `GET /` and `/static/*` | Files from `public/` |

Path params are checked against existing watch ids, so they can't be used to read other files.

Local-only hardening (machine only, agreed 2026-11-14):
- Reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding.
- The POST needs `Content-Type: application/json` and an `Origin` matching the server. Another site open in the browser then can't mark alerts read.

## 8. Frontend (no wireframes yet: data and behavior only)

`public/index.html`, `public/app.js`, `public/style.css`. Plain JS modules with no build step.

- **Watches list:** one row per watch with status, progress (`3/6`), next pass countdown and headline counts. Click through to a watch.
- **Watch view:**
  - **Listings table:** image, title, current price, change since first seen, status badge (new this pass, price dropped, sold, missing), location, first/last seen, link to Facebook. Sort by price, newest or biggest drop. Filter by status and price range.
  - **Price history:** a small line per listing from `priceHistory`.
  - **Events timeline:** "₱2,000 drop on X", "3 new listings", "Y marked sold", grouped by pass.
  - **Pass log:** time, cards read, visits used, errors.
- **Alerts:**
  - An unread badge on every page, also shown in the tab title, e.g. `(3) pst`.
  - An alerts list showing time, watch, rule, listing (with a link), price and was-price, and the reason.
  - Mark one or all as read.
  - Listing rows with an alert get highlighted, and filtering by "alerted" works.
  - The watch view shows the watch's rules as chips. Rules can't be edited during a watch in v1.
- **Until / progress:** the watch view shows `3/17 · until 18:00 · next in 12m`.
- **Location:** the watch header shows the search area (`Pasig City · 6 km`), plus a warning if a pass reported a different area.
- **Live:** polls `/api/watches/:id` and `/api/alerts?unread=1` every 15 s while a watch is running. That's enough for passes 10+ minutes apart, so no websockets.
- **Images:** card images are signed fbcdn URLs that expire. v1 shows them directly and falls back to a placeholder. Downloading thumbnails is a later option.

## 9. Files to add or change

| File | Change |
|---|---|
| `src/fb.js` | `marketplaceSearch`, `readListingCards`, `readListingDetail`; daily counter hook in `open()` |
| `src/guard.js` | `DailyBudget` (persisted counter) |
| `src/config.js`, `.env.example` | `MAX_DAILY_VISITS`, `UI_PORT`, `MARKET_LOCATION`, `MARKET_RADIUS_KM`, `MARKET_CURRENCY` |
| `src/alerts/rules.js` | `parseRule`, `evaluate(rule, listing, ctx)`, firing logic (pure) |
| `src/alerts/notify.js` | Per-OS notification: a pure `buildCommand(platform, title, body)` plus a spawn wrapper |
| `src/market/parse.js` | Card and price parsing |
| `src/watch/diff.js`, `store.js`, `runner.js` | Tracking, storage, pass loop |
| `src/watch.js` | CLI entry, argument parsing |
| `src/server.js`, `public/*` | UI |
| `package.json` | `watch`, `ui` scripts |
| `test/parse.test.js`, `test/diff.test.js`, `test/store.test.js`, `test/args.test.js`, `test/rules.test.js`, `test/notify.test.js` | Unit tests with saved card-text fixtures. Args cover `--until` and pass counts; rules cover syntax, firing and re-firing; notify checks that titles are passed as arguments, not script text |

## 10. Milestones

1. **One-shot search.** `npm run market -- "<query>"` runs one pass and prints the parsed listings, then opens 1 detail page. Find Pasig's location value and check whether the radius param works. Tune selectors on the live page and save real card and detail texts (with personal names removed) as test fixtures. Parser tests.
2. **Watch.** Diff, details queue, store, runner, `--times`/`--until`, daily cap, CLI. Run a real 3-pass watch at 10m intervals.
3. **Alerts.** Rule parser and evaluation, firing state, desktop notifications on macOS (Windows checked on the Windows machine), console output.
4. **UI.** Server and page showing watches, listings, history, events and alerts, with mark-as-read.
5. **Later, only if needed:** start or stop watches and edit rules from the UI (the server spawns the watcher process); downloaded thumbnails; phone alerts; several queries per watch sharing one daily budget; LAN or phone access with auth.

## Proposed decisions (add to `docs/decisions.md` once agreed)
- **D-005:** JSON files in `output/` as the store, written atomically. Revisit if a watch grows past a few thousand listings.
- **D-006:** The watcher and the UI are separate processes. The UI's only write is alert read-marks, so the browser page can never trigger Facebook visits. The server binds to 127.0.0.1 only.
- **D-007:** A persisted daily visit cap (`MAX_DAILY_VISITS`) on top of the per-run budget. Searches are reserved first, and details use what's left.
- **D-008:** Alerts are sent by the watcher as local desktop notifications. No outside notification service for now.

## Open questions
- None blocking. To be checked in milestone 1: Pasig's location slug or id, and whether `radius` works in the URL.

## Risks
- Marketplace markup and URL params change, so `src/fb.js` and the parsers need upkeep. Fixtures make breakage show up in tests.
- Long watches mean more total visits. The daily cap, minimum interval and jitter keep the pace human.
- Search results vary between passes, so "missing" is a guess, not proof of a sale.
- Details multiply visits. The searches-first reserve and the per-pass cap bound this, but a busy query can leave a details backlog that never clears. The UI shows the queue length.
- Desktop notifications depend on OS permission. If they're blocked, the console and UI still get every alert.
