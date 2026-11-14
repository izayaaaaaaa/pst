# pst — Deal hunting plan

## Goal
Two standing jobs on the user's own Chrome, built on the Marketplace watch that already works
(`marketplace-watch.md`, live-tuned 2026-11-14):

1. **Tech deals on Marketplace** — monitors and networking hardware (switches, routers, APs,
   Ubiquiti/Mikrotik-class gear) around Pasig at clearly low prices.
2. **Property rentals** — rental listings in Facebook groups, and Marketplace's property-rentals
   category if it works in the URL (e.g. 1–2 BR units near Pasig under a monthly budget).

"Standing" is the key word: these run most days, not once. This plan specifies only what the
current version can't do yet; everything else (passes, diffing, details, alerts, daily cap,
quiet hours, lock, UI) is reused as built.

## What the current version gives us, and the gaps

| Need | Current version | Gap |
|---|---|---|
| Search one query, watch passes, diff, details, alerts | done, live-tuned | only **one query per watch** |
| Run more than one watch at once | forbidden by the `output/watches/.lock` lockfile (D-006/D-007 world) | deal hunting needs ~5–10 queries and later 2–4 groups |
| "Good deal" signal | `price<N`, `drop>=N` (relative to the listing's own first-seen price) | no reference price for the market: nothing says "₱4,500 is cheap for a 27\" 1440p monitor" |
| Day-to-day operation | a watch starts from nothing: first-seen prices, alert state and any baseline reset each run | no saved specs, no way to continue yesterday's watch |
| Rentals from groups | `readPosts` is a rough, untuned reader of feed text; `npm start -- <groupId>` prints it | no post ids, no scroll-collect, no rental field parsing, no alerts on posts |
| Rentals from Marketplace | search pipeline is generic, but the rentals category is not reachable from the CLI | no `--category`; category URL shape unverified |

## Constraints carried over
- Attach only (D-001), all navigation through `Facebook.open()` (budget, pauses, checkpoints).
- One watch at a time (lockfile). This plan works **with** that, not around it: many sources in one watch.
- Quiet hours, per-run budget, and the persisted daily cap (`MAX_DAILY_VISITS`, D-007) all apply unchanged.
- Plain JS, no build step (D-004). Marketplace selectors stay in `src/fb.js`; parsing stays pure and fixture-tested.
- Build offline first, tune live with the user (D-009). Same rule for group feeds.

## Overview

```
npm run watch -- @tech-deals                      # saved spec (Part C)
   │  sources: "monitor 27", "monitor 24", "network switch", "ubiquiti", "router", ...
   │
   ├─ pass 1 ─► search "monitor 27" ─► search "network switch" ─► merge cards ─► diff ─► 2 details ─► alerts
   ├─ pass 2 ─► search "monitor 24" ─► search "ubiquiti"      ─► merge ─► diff ─► ...
   ├─ pass 3 ─► search "router"      ─► search "monitor 27"   ─► ... (round-robin, cursor in watch.json)
   │
   └────────► output/watches/<id>/  (same id across days via --continue)  ◄── npm run ui
```

A watch is a set of **sources**. A source is a Marketplace query or (Part E) a group. Each pass
searches a few of them, in rotation. All sources feed one listings store, keyed by item/post id,
so the same Marketplace item found by two queries is one listing, not two.

## Part A — sources and rotation

### WatchSpec
```js
{ name: 'tech-deals' | null,
  sources: [
    { type: 'market', query: 'monitor 27' },        // filters: the CLI flags, shared by all market sources
    { type: 'market', query: 'network switch' },
    { type: 'group',  id: '1234567890', label: 'Pasig condo rentals' },   // Part E
  ],
  sourcesPerPass: 2,
  times, until, everyMs, maxListings, detailsPerPass, alerts, desktop, currency }
```

CLI (extends the current syntax, everything old still parses):
- The positional query stays the first market source; `--also "<query>"` (repeatable) adds more.
  Per-source filters are not expressible on the CLI in v1 — flags apply to every market source;
  saved-spec JSON is the escape hatch.
- `--per-pass N` (1–4, default 2): sources searched per pass.
- `--group <idOrSlug>` (repeatable): Part E.
- `@<name>` as the positional argument runs a saved spec (Part C).

### Rotation
`watch.json` gains `nextSource` (an index, saved each pass). Pass *n* searches
`sources[nextSource .. nextSource+S)` with wraparound, then advances the cursor by S. Every
source is therefore searched every `ceil(N/S)` passes:

| Sources | Per pass | `--every` | Each source searched |
|---|---|---|---|
| 5 queries | 2 | 45m | ~every 90m |
| 8 (5 queries + 3 groups) | 2 | 45m | ~every 3h |
| 8 | 3 | 45m | ~every 2¼h |

Rotation is the knob that trades freshness per source against visits per day; the UI shows the
cadence so it's visible, not felt.

### Merged diff, one store
- Market sources in a pass contribute cards to one `seen` map (dedup by item id) before a single
  `diff()` call, so events fire once even if two queries return the same item.
- Each listing records `queries: [...]` (which searches have matched it) — used by the median
  clause (Part B) and shown in the UI as chips.
- `createWatchId` keys off the spec `name` when given, so `--continue` can find the watch again.

### Budget math (per D-007)
- Visits per pass = `S` searches + details opened. The runner's reservation becomes
  `searchesRemaining = S × passesRemaining` (rotation guarantees exactly that), and the per-run
  budget is `Budget(S + k)`.
- Example days at `MAX_DAILY_VISITS` default 60, 08:00–22:00 (quiet hours don't bite):
  - **Tech only**: 5 queries, `--per-pass 2`, `--every 45m` (≈19 passes): 38 search visits +
    ~2 details/pass ≈ 25 → **~63. Just over the 60 default.**
  - **Tech + rentals**: 8 sources, same shape: 38 searches + ~15 details → **~55. Fits.**
- So the default 60 works for one combined watch with `--details 2`; a tech-only day wants
  `MAX_DAILY_VISITS` ≈ 90 (open question Q2). Pacing per visit is unchanged in every case.

## Part B — deal clauses (alerts)

Two new clause types in `src/alerts/rules.js`, same syntax family as the rest:

| Clause | True when |
|---|---|
| `below-median:<P>%` | The price is at least P% below the running median for the listing's query (see below) |
| `condition:<text>` | The detail's condition contains the text, case-insensitive: `condition:brand new`, `condition:like new`. Only matchable once details are in, exactly like description keywords |

- **Running median, per query:** median of current prices over `status: 'active'` listings that
  matched that query and have a price. Recomputed from the store each pass — no new files, no
  extra visits. Needs ≥ 5 priced active listings; below that the clause doesn't match (reason:
  "not enough prices yet for `<query>`"), which keeps early passes quiet instead of noisy.
- The runner computes the medians once per pass and passes them into `fire()`/`evaluate()` as
  `ctx.medians`; each listing looks up its own query's median via `listing.queries`.
- Reason text stays concrete: `₱4,500 is 44% below the "monitor 27" median ₱8,000`.
- Medians are per watch (per query), so a continued watch (Part C) has a real market-rate history
  within days, across fresh listings and price drops alike.

### Example rules for the tech watch
```
--alert "new&price<7000&-keyword:crack"                    # fresh cheap listing, no crack mention
--alert "below-median:30%&-keyword:for parts&-keyword:sira&-keyword:busted"
--alert "condition:brand new&price<5000"                   # sealed-type pricing on used market
--alert "keyword:ubiquiti&price<3000"                      # gear that resells well
```
Negative keywords carry real weight in PH second-hand listings (`sira`, `busted`, `for parts`,
`no adapter`, `dents`); they're just `keyword:` clauses that already work.

## Part C — daily flow: saved specs and `--continue`

### Saved specs
- `output/saved/<name>.json`: one saved WatchSpec plus `{ lastWatchId }`. Plain JSON, edited by
  hand (per-source filters, query lists) — no UI editor in v1 (old plan milestone 5 keeps that door).
- `npm run watch -- "monitor 27" --also "network switch" ... --save-as tech-deals` — validates the
  whole spec (including alert rules) and **exits without any visit**.
- `npm run watch -- @tech-deals [--times N | --until 18:00]` — runs it; `--times`/`--until`
  override the saved values for this run only.
- `npm run saved` — lists saved specs and their source counts.

### `--continue <watchId>`
- Loads `watch.json`, `listings.json` and `alertState.json` from that watch; pass numbering
  continues; `nextPassAt` is now; `times`/`until` come from the CLI.
- First-seen prices, price history, medians and alert firing state all survive, which is the
  point: `drop>=10%` and `below-median:30%` mean something on day 4, not just day 1.
- A saved spec with `"continue": true` remembers its `lastWatchId` and continues it automatically
  when run again (a fresh watch only if that store is gone).
- One command per morning: `npm run watch -- @tech-deals` with `--until 22:00` in the spec.
  Cron/Task Scheduler stays "later" exactly as `setup.md` says.

## Part D — rentals on Marketplace

Marketplace itself has a Property Rentals category (it's in the left-rail category list on a
live item page). If its URL shape is usable, the whole card → detail → diff → alert pipeline
applies to rentals with no new parsing:

- **Live step, with the user (once):** open Marketplace by hand, click Property Rentals, read
  the URL — a category slug on `/marketplace/<location>/category/...` or a `category=` search
  param. Same drill as finding Pasig's location value (mw milestone 1).
- `--category <slug>` on `npm run market` and `npm run watch` — extends `marketplaceSearchUrl`
  only. Filters (`--max-price 20000`, `--radius 15`) apply as-is: the price on a rental card is
  the monthly rent.
- Cards are expected to be the same grid; if rental cards differ, that's a fixture + parser tweak,
  sized like the `Just listed` badge fix was.
- Alerts: `price<18000&keyword:2br`, `new&keyword:condo&keyword:ortigas` — nothing new needed.
- Rentals likely want a wider radius than goods (people commute); saved specs carry their own
  `--radius`, so `@rentals` can be 15 km while `@tech-deals` stays 6.

## Part E — rentals (and anything else) from group posts

The genuinely new surface. Built the same way Marketplace was: read → dump → tune → fixtures.

### Reading posts
- `Facebook.readGroupPosts(max = 30)` in `src/fb.js`, same scroll-collect pattern as
  `readListingCards`: scroll in rounds, collect `[role="feed"] > div` post containers, dedup by
  **post id from the permalink** (`a[href*="/posts/"]`, `a[href*="/permalink"]`,
  `a[href*="story_fbid"]` — tuned live), stop at `max`, 2 stale rounds or 10 rounds. Values are
  copied out per round (inner text), never held as live DOM handles across scrolls, because the
  feed virtualizes old posts away.
- Raw post: `{ id, href, text }`. Author and time text are read opportunistically from the
  post container and kept when tuning shows they're stable; both are display-only.
- `npm run groups -- <idOrSlug> [--raw] [--limit N]` — one-shot reader mirroring `npm run market`:
  prints parsed posts, `--raw` dumps the first few raw post texts for tuning. This is the
  milestone-1-style live step: run it with the user on 2–3 real rental groups, save cleaned
  fixtures (names stripped), tune until post ids and texts are right.

### Parsing posts (pure)
`src/groups/parse.js`, sibling of `src/market/parse.js`:
- `postIdFromHref(href)`.
- `parsePost(raw, { groupId })` →
  `{ id: 'g:<groupId>:<postId>', url, title (first non-empty line, capped), text, price,
     rent: { beds, advanceMonths, depositMonths } | null, authorName, timeText }`
- PH notation the price parser handles here: `15k` / `15K` / `₱15k` / `15,000` / `15k/mo`,
  `/mo|per month|monthly` on the same line. Marketplace's `parsePrice` stays untouched; the
  k-notation helper lives with the group parser.
- Rent fields by plain regex: beds `1br|2 br|2-bedroom|studio`, terms `1 month advance`,
  `2 months deposit`. Anything not found is null — **no post is ever dropped for parsing badly.**
  A post simply keeps its text and still alerts on keywords.
- Buy/sell-style group posts (listing cards with price in the feed) parse through the same
  `parsePost`; the first line carries the price there.

### Diff, alerts, cost
- Same `diff()` with namespaced ids (`g:<groupId>:<postId>` vs bare Marketplace item ids — they're
  both numeric strings, so they must never share a keyspace). `title` = first line; a text edit
  that moves the price shows up as `price_drop`/`price_up` like any edit.
- "Missing" is weaker here: group feeds churn by ranking more than search does. Keep the 2-pass
  rule, and say so in the UI (a missing post is "not seen", not "gone").
- Posts have no detail page — the feed text *is* the detail — so posts never enter the details
  queue. A group source costs exactly **one visit per pass**, which is what makes Part A's budget
  math work.
- Alerts: `price<18000&keyword:2br`, `new&keyword:near ortigas`, `-keyword:agent` — all existing
  clause types, evaluated over title + text.

### UI (both parts)
- Post rows in the listings table: title = first line, author, text excerpt on expand, price and
  `2br · 1mo adv · 1mo dep` chips, permalink link, group label chip.
- Median per query shown in the watch header (`monitor 27 · median ₱8,000 · 12 active`), and
  below-median listings get the same highlight as alerted ones.
- Source chips per listing (which queries matched), and the rotation cadence
  (`8 sources · 2/pass · each ~every 3h`) in the watch view.

## Files to add or change

| File | Change |
|---|---|
| `src/watch/args.js` | `--also`, `--group`, `--per-pass`, `--category`, `--save-as`, `--continue`, `@name`; multi-source WatchSpec |
| `src/watch/runner.js` | rotation cursor, merged per-pass diff, `ctx.medians`, continue mode, `S`-sized budget/reservation |
| `src/watch/store.js` | saved specs (`output/saved/`), continue loading, `nextSource` cursor |
| `src/fb.js` | `readGroupPosts`; `marketplaceSearchUrl` category param; group permalink selectors |
| `src/market/parse.js` | unchanged (maybe export `isPriceLine` for reuse) |
| `src/groups/parse.js` | new: `postIdFromHref`, `parsePost`, k-notation, rent fields |
| `src/alerts/rules.js` | `below-median` and `condition` clauses; `ctx.medians` in evaluate/fire |
| `src/groups.js`, `src/saved.js` | new CLIs: `npm run groups`, `npm run saved` |
| `src/server.js`, `public/` | post rows, median display, source chips, cadence |
| `package.json` | `groups`, `saved` scripts |
| `test/` | args (multi-source, @name, continue), runner (rotation, merged diff, reservation), rules (below-median, condition), groups-parse fixtures, server |

## Milestones
1. **Daily flow** (offline only, no new FB surface): saved specs, `@name`, `--continue`. Verify by
   re-running the existing single-query watch as a saved spec twice in one day.
2. **Search sets + deal clauses:** `--also`, rotation, merged diff, per-query medians,
   `below-median`, `condition`. Live with the user: one 2-pass watch over ~5 tech queries.
3. **Marketplace rentals:** hand-verify the category URL, `--category`, saved `@rentals` spec,
   live-check rental cards parse. Small if the URL cooperates.
4. **Group reading:** `npm run groups` + `--raw`, tune `readGroupPosts` live on 2–3 rental
   groups, post fixtures. No watching yet.
5. **Group watches:** `parsePost` rent fields, `--group` sources, namespaced diff, alerts on
   posts, UI rows. Live: a one-day combined `@tech-deals`+groups watch, checked in the UI.
6. **Later, only if needed:** repost linking (same unit, new post id → link by title/beds/price
   proximity), seller-quality clause (rating/joined-year from detail pages), scheduled launch,
   cross-watch dedup.

## Proposed decisions (add to `docs/decisions.md` once agreed)
- **D-010 — one watch, many sources.** A watch covers a set of Marketplace queries and groups,
  rotated across passes, into one store. Why: the lockfile allows one watch; the daily cap is
  shared anyway; and one store dedups the same item across queries for free.
- **D-011 — saved specs + `--continue`.** Specs live in `output/saved/<name>.json`; a watch can be
  continued across days so first-seen prices, medians and alert state persist. Why: deal hunting
  is a standing job; a daily baseline reset would gut `drop>=` and `below-median`.
- **D-012 — the deal reference is the watch's own running median.** Per query, active listings
  with prices, ≥ 5 samples, recomputed each pass. No external price sources: nothing to scrape,
  no third party gets query data, and the reason text is checkable in the UI.
- **D-013 — group posts are read like cards, parsed like text.** Scroll-collect with permalink
  ids; rental fields by regex with nulls, never dropped; posts don't open detail pages (one visit
  per group per pass). Why: the feed virtualizes, posts are unstructured, and the budget math
  only closes if groups cost one visit.
- **D-014 — rentals also via Marketplace category** (`--category`), once the URL is verified live.
  Why: it reuses the whole live-tuned pipeline; groups cover what Marketplace's category misses.

## Open questions
- **Q1 — tech query list** (feeds `@tech-deals`). Proposal to start:
  `monitor`, `monitor 27`, `monitor 24`, `ultrawide monitor`, `network switch`, `ubiquiti`,
  `router`, `access point`. Trim to fit Part A's budget table.
- **Q2 — `MAX_DAILY_VISITS`:** keep 60 with one combined watch (`--details 2`), or raise to ~90
  for a tech-only watch at full freshness? Pacing per visit is unchanged either way; the account
  risk is the user's call.
- **Q3 — which rental groups** (ids/slugs, from the group URL), and are they buy/sell-style or
  free-text discussion groups? Affects fixture variety in milestone 4.
- **Q4 — rental alert shape:** area (Pasig only? wider?), monthly budget, bedrooms, deal-breaker
  keywords (`agent`, `bedspace`, `short term`?).
- **Q5 — Marketplace rentals URL:** to verify by hand in the milestone-3 live step.

## Risks
- Group feed markup churns and virtualizes; the scroll-collect pattern, `--raw` dumps and
  fixtures keep breakage visible in tests, exactly as with Marketplace cards.
- Unstructured rental text means wrong or missing fields; mitigations: no post is dropped,
  parsed fields are display chips not gates, medians need ≥ 5 samples, alerts stay keyword-first.
- A higher daily cap is a real trade against account risk (Q2); rotation and `--details 2` are
  the in-60 alternatives.
- Medians can be skewed by mispriced or miscategorized listings; with ≥ 5 active samples one
  listing moves a median little, and the median is shown, not hidden.
- More sources per watch means slower cadence per source — the rotation table makes the trade
  explicit instead of silent.
