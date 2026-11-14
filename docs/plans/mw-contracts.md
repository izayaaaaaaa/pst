# Marketplace watch (MW) — build contracts

Written by the planner (Opus 5.5), 2026-11-14. The build spec for the MW run. Builders build **only** from this file plus:
`CLAUDE.md`, `docs/decisions.md` (D-001 to D-009), `docs/plans/marketplace-watch.md` (background; **this file wins** where they differ), and the existing code in `src/` and `test/`.

**If something here is wrong or unclear:** pick the least surprising option that fits `CLAUDE.md`, build it, and report it as a contract issue in your final message. Don't quietly do something different.

**Privacy:** no real data anywhere in code, tests or fixtures. Listing titles, sellers, prices, ids and places in tests are made up (e.g. `"Test Phone 128GB"`, seller `"Juan Test"`, id `"1000000000000001"`). Nobody reads `.env`.

**No live Facebook in this run (D-009):** don't run `npm start`, `npm run chrome`, `npm run watch`, `npm run market` or `npm run ui` against a real browser. Don't connect to port 9222. Don't send real desktop notifications. Tests inject fakes for page, spawn, clock and sleep.

---

## 0. Scope

| In | Out (later, live with the user, or not at all) |
|---|---|
| Card, price and detail parsing; diff and tracking; details queue | Tuning selectors on the live page (milestone-1 live step, after this run) |
| Alert rules, firing, notification commands | Pasig's real location slug or id (found live; until then `MARKET_LOCATION` is empty and the profile's location is used) |
| `DailyBudget`, config additions, JSON store, lockfile | Starting or stopping watches from the UI, editing rules from the UI |
| `Facebook` Marketplace methods with best-guess selectors | Phone alerts, LAN access, thumbnail downloads |
| Watch runner, `watch` / `market` CLIs | New npm dependencies |
| Local server and the frontend page | |

## 1. Ground rules

- Node ≥ 20, ESM, plain JS with JSDoc. **No new dependencies**: `package.json` `dependencies` must not change. Only node built-ins (`node:fs`, `node:path`, `node:http`, `node:util`, `node:child_process`, `node:test`, …).
- **Money:** inside the program, amounts are integers in **minor units** (centavos): ₱25,000 → `2500000`. `Price = { amount: number|null, currency: string|null, raw: string }`. Search filters (`minPrice`, `maxPrice`) are **whole units**, because Facebook's URL takes whole units.
- **Time:** timestamps are ISO strings from `new Date().toISOString()`. Wall-clock things (quiet hours, `--until 18:00`, daily counter date) use **local** time.
- **Pure modules stay pure:** `src/market/parse.js`, `src/watch/diff.js`, `src/alerts/rules.js`, and `buildCommand` / `alertsToNotifications` in `src/alerts/notify.js` do no I/O and don't import `config.js`. Functions return new objects and never mutate their inputs.
- **File I/O** uses sync `node:fs`. JSON writes are atomic: write `<file>.<pid>.tmp`, then `renameSync`.
- **Selectors:** every facebook.com selector lives in `src/fb.js` (CLAUDE.md).
- **Tests:** `node:test` + `node:assert/strict`. Tests must not depend on `.env` or on `config` values: pass explicit options. Temporary dirs come from `fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'))` and are removed after. Run tests in the **foreground**, never with Monitor or a background job. Kill only processes you started.
- **Errors** are `Error` objects with plain messages. Messages the runner matches on are pinned in §6.

## 2. Shared shapes

```js
/** One card from a search pass (parse.js → diff.js) */
CardListing = { id, url, title, price: Price|null, location: string|null, image: string|null,
                label: null | 'sold' | 'pending' }

/** Parsed detail page (parse.js → diff.js) */
Detail = { title: string|null, price: Price|null, label: null|'sold'|'pending',
           description: string|null, sellerName: string|null, postedText: string|null, condition: string|null }

/** Stored per listing (diff.js; listings.json) */
TrackedListing = {
  id, url, title, image, location,
  price: Price|null,
  priceHistory: [{ pass, at, amount }],        // first point when first seen (if amount != null); a point on each change
  firstSeen: { pass, at }, lastSeen: { pass, at },
  lastRank: number,                            // 0-based position in the last pass that saw it
  missedPasses: number,
  status: 'active' | 'pending' | 'sold' | 'missing',
  detail: null | { description, sellerName, postedText, condition, at } }

/** Event (diff.js; events.jsonl) */
Event = { at, pass, type, listingId, from, to }
// type: 'new' | 'price_drop' | 'price_up' | 'title_change' | 'sold' | 'pending' | 'missing' | 'back'
// from/to: amounts for price events, strings for title_change, previous/new status for status events, null for 'new'

/** AlertRule (rules.js; stored in watch.json under spec.alerts) */
AlertRule = { id: 'r1', text, clauses: Clause[] }
Clause = { type: 'price', op: '<' | '<=', amount }          // amount in minor units
       | { type: 'drop', amount } | { type: 'drop', percent }
       | { type: 'new' }
       | { type: 'keyword', text, negate: boolean }          // text already normalized

/** Alert (rules.js; alerts.jsonl) */
Alert = { id, at, pass, watchId, ruleId, ruleText, listingId, title, url, location,
          price: Price|null, prevPrice: Price|null, reason }

/** WatchSpec (args.js) */
WatchSpec = { query, filters: { minPrice, maxPrice, location, radiusKm, daysSinceListed },
              times, until: string|null, everyMs, maxListings, detailsPerPass, alerts: AlertRule[],
              desktop: boolean, currency }

/** Watch (watch.json) = WatchSpec plus: */
{ id, createdAt, status, passesDone, passesTotal, nextPassAt, lastError, searchArea, detailsQueued }
// status: 'running' | 'done' | 'stopped' | 'stopped_budget' | 'stopped_checkpoint' | 'error'

/** Pass record (passes.jsonl) */
Pass = { n, startedAt, endedAt, ok, error, seenIds, cardsRead, detailsOpened, visits, searchArea }
```

---

## 3. Task A — parsing and tracking (plan §3, §4)

### 3.1 `src/market/parse.js`

- `itemIdFromHref(href) → string|null`: digits after `/marketplace/item/`, for absolute or relative hrefs, with or without query string. Otherwise null.
- `parsePrice(text, defaultCurrency = 'PHP') → Price|null`: the **first** price in `text`.
  - Symbols: `₱`→PHP, `$`→USD, `€`→EUR, `£`→GBP. Codes `PHP`, `USD`, `EUR`, `GBP` before the number, with or without a space.
  - Thousands commas; optional decimals (`₱1,200.50` → 120050).
  - `Free` (any case, whole token) → `{ amount: 0, currency: defaultCurrency, raw: 'Free' }`.
  - A bare number with no symbol or code isn't a price → null.
  - `raw` is the matched substring, trimmed.
- `parseCard({ href, text, img }, { currency = 'PHP' } = {}) → CardListing|null`
  - Lines: `text.split('\n')`, trimmed, empties dropped.
  - null when: there is no item id; any line is exactly `Sponsored` (any case); or no line is a title.
  - Label: a line exactly `Sold` or `Pending` (any case) sets `label`, and that line is skipped.
  - **Price lines:** a line that is nothing but a price (or `Free`). The first price line gives `price`. Further price lines right after it (a struck-through old price) are skipped.
  - Title: the first remaining line that isn't a price line or a label. Location: the next remaining line after the title, or null.
  - `url`: `https://www.facebook.com/marketplace/item/<id>/`. `image`: `img || null`.
- `parseDetail(raw, { currency = 'PHP' } = {}) → Detail`. `raw = { title, priceText, labelText, description, sellerName, postedText, condition }`, each a string or null.
  - Trims every string; empty → null. `price = parsePrice(priceText)`.
  - `label` from `labelText`: contains `sold` → 'sold', contains `pending` → 'pending', else null.

### 3.2 `src/watch/diff.js`

- `diff(known, seen, ctx) → { known, events }`. `ctx = { pass, at, maxListings, cardsRead }`.
  - `seen` is `CardListing[]` in page order. Duplicates by id: keep the first.
  - **New id:** add a `TrackedListing` (status from label, or 'active'; `priceHistory` gets one point if amount != null; `missedPasses` 0; `detail` null). Emit `new` unless `ctx.pass === 1`. If the label is sold/pending, emit no status event for it.
  - **Known id, seen:** update `lastSeen`, `lastRank`, `image`, `location`, `url`; reset `missedPasses` to 0.
    - **Price:** if both amounts are non-null with the same currency and they differ, emit `price_drop` or `price_up` (from/to amounts), set `price`, push a history point. If the stored amount is null and the new one isn't, set it and push a point, with no event.
    - **Title:** if the new title is non-empty and different, emit `title_change` and set it.
    - **Status**, applied in this order:
      - label 'sold' and status isn't sold → `sold`.
      - label 'pending' and status isn't pending → `pending`.
      - no label, and status is 'missing', 'sold' or 'pending' → status 'active', emit `back`.
  - **Known id, not seen**, with status active or pending: count a miss only if `ctx.cardsRead < ctx.maxListings` (results ran out) **or** `lastRank < Math.floor(maxListings * 0.75)`. Otherwise leave it unchanged. When `missedPasses` reaches 2, set status 'missing' and emit `missing`. Sold and missing listings that aren't seen stay unchanged.
  - Events come out in `seen` order, then not-seen listings sorted by id.
- `applyDetail(known, id, detail, ctx) → { known, events }`. `ctx = { pass, at }`.
  - Unknown id → returns its inputs unchanged.
  - Sets `detail = { description, sellerName, postedText, condition, at }`.
  - Applies `detail.price`, `detail.title` and `detail.label` with the same rules as a seen card. The one exception: a null label does **not** emit `back` (the detail page may just not show labels).
- `detailQueue(known, { isPriority = () => false } = {}) → string[]`: ids with `detail === null` and status active or pending. Order:
  1. priority first;
  2. then price amount ascending (null last);
  3. then `firstSeen.pass` ascending;
  4. then id.

### 3.3 Tests: `test/parse.test.js`, `test/diff.test.js`
Must test:
- **itemIdFromHref:** absolute, relative and query-string forms, and a non-item href.
- **parsePrice:** `₱1,200`, `PHP 1,200`, `PHP1200`, `$50.50`, `Free`, a bare number (null), and text with two prices (the first wins).
- **parseCard:**
  - the normal 3-line card;
  - a discounted card with 2 price lines;
  - Sold and Pending cards;
  - a Sponsored card (null);
  - a card with no location;
  - a card with no id (null).
- **parseDetail:** price and label parsing; empty strings become null.
- **diff:**
  - pass 1 emits no `new`, and pass 2 does;
  - drop, rise, and a price from null with no event;
  - title change;
  - sold, pending, and back from sold;
  - missing after 2 misses; the 75% rank rule with a full page vs results running out; back from missing;
  - duplicate ids;
  - inputs are not mutated (`structuredClone` before, `deepEqual` after).
- **applyDetail:** fills detail; a price change emits an event; a null label doesn't emit `back`.
- **detailQueue:** ordering, priority first, and that sold, missing and detailed listings are excluded.

Fixture card texts are inline strings in the tests, all made up.

---

## 4. Task B — alerts (plan §5a)

### 4.1 `src/alerts/rules.js`

- `normalizeText(s)`: lowercase; `NFD` with combining marks removed; whitespace collapsed to single spaces; trimmed.
- `formatMoney(price) → string`: `{amount, currency}` → `₱24,500`, `$12.50`, `€3`, `£1,000`.
  - Unknown currency → `XYZ 1,000`.
  - Whole amounts have no decimals; otherwise 2 decimals.
  - null price or null amount → `?`.
- `parseRule(text, id) → AlertRule`. Throws `Error('Bad alert rule "<text>": <reason>')`.
  - Split on `&` outside double quotes; trim each clause; empty clause → error.
  - `price<N` and `price<=N`: N is whole units, commas allowed → minor units.
  - `drop>=N` → `{type:'drop', amount: N*100}`. `drop>=P%` → `{type:'drop', percent: P}`, with 0 < P ≤ 100 and decimals allowed.
  - `new`.
  - `keyword:<text>` and `-keyword:<text>`: text is bare (up to the next `&`) or double-quoted; it's normalized, and empty is an error.
  - No spaces allowed inside `price<N` etc. Anything else → error naming the clause.
- `parseRules(texts) → AlertRule[]`, with ids `r1`, `r2`, … in order.
- `evaluate(rule, listing, { isNew }) → { match, reason }`
  - Status other than 'active' → `{ match: false, reason: '' }`.
  - **price:** amount non-null and `<` or `<=` N.
  - **drop:** needs `priceHistory[0].amount` (the first price) and the current amount, both non-null, with first > 0.
    - amount form: `first − current ≥ amount`.
    - percent form: `(first − current) / first × 100 ≥ percent`.
  - **new:** `isNew`.
  - **keyword:** search text = `normalizeText(title + ' ' + (detail?.description ?? ''))`. Matches if it contains the text, or doesn't contain it when `negate`.
  - `reason`: clause reasons joined with `; `:
    - `price ₱24,500 < ₱25,000`
    - `down ₱2,500 (9%) since first seen`
    - `new`
    - `has "256 gb"`
    - `no "icloud"`
- `cardMatches(rule, listing) → boolean`: `evaluate` with `isNew: true` (used for details-queue priority).
- `fire(rules, known, state, { pass, at, watchId, newIds }) → { state, alerts }`
  - Goes over rules in order, and listings sorted by id. `key = ruleId + ':' + listingId`, `prev = state[key]`, `amount = listing.price?.amount ?? null`, `r = evaluate(rule, listing, { isNew: newIds.has(id) })`.
  - Alert when:
    - `r.match && !prev?.matched`, or
    - `r.match && prev.matched && prev.lastPrice !== amount`.
  - New state for the key: `{ matched: r.match, lastPrice: amount }`. Returns a new state object; the input isn't mutated.
  - Alert fields:
    - `id = watchId:pass:ruleId:listingId`.
    - `prevPrice`: on a re-fire, `{ amount: prev.lastPrice, currency }`. On a first fire, the second-to-last `priceHistory` amount if there is one; else null.
    - `reason`: on a re-fire, `r.reason + '; was ' + formatMoney(prevPrice)`.

### 4.2 `src/alerts/notify.js`

- `buildCommand(platform, title, body) → { cmd, args, env } | null`
  - Title and body first get control characters replaced by spaces, then are truncated to 64 and 200 characters (ending in `…` when cut).
  - **darwin:** `cmd: 'osascript'`, `args: ['-e','on run argv','-e','display notification (item 2 of argv) with title (item 1 of argv)','-e','end run', title, body]`, `env: {}`.
  - **win32:** `cmd: 'powershell.exe'`, `args: ['-NoProfile','-NonInteractive','-Command', WIN_TOAST_SCRIPT]`, `env: { PST_TITLE: title, PST_BODY: body }`. `WIN_TOAST_SCRIPT` is exported, constant, and exactly:
    ```powershell
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
    $t = $xml.GetElementsByTagName('text')
    $t.Item(0).AppendChild($xml.CreateTextNode($env:PST_TITLE)) > $null
    $t.Item(1).AppendChild($xml.CreateTextNode($env:PST_BODY)) > $null
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
    ```
  - **linux:** `cmd: 'notify-send'`, `args: ['--app-name=pst', '--', title, body]`, `env: {}`.
  - Any other platform → null.
- `alertsToNotifications(alerts, { query, max = 3 }) → { title, body }[]`
  - Title: `pst · <query>`.
  - Body: `formatMoney(price)`, plus ` (was <prev>)` if `prevPrice`, then ` · <title>`, then ` · <location>` if there is one.
  - If `alerts.length > max`: the first `max − 1` are listed one each, then a summary with body `+<n> more alerts for <query>, see the UI`.
- `async notify(notifications, { platform = process.platform, spawn = child_process.spawn, log = console.log } = {})`
  - For each notification: `buildCommand`.
    - null → `log` the title and body, plus `'\x07'`.
    - Otherwise `spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' })` and await `exit` or `error`. A spawn error or non-zero exit → the same log fallback.
  - Never uses `shell: true`. Never throws.

### 4.3 Tests: `test/rules.test.js`, `test/notify.test.js`
Must test:
- **parseRule:** every clause type; quoted keyword with `&` inside the quotes; commas in amounts; errors for `price<`, `drop>=0%`, `foo`, an empty clause, and `price < 5`.
- **evaluate:** each clause, including the non-active status short-circuit; keyword matches the description once details are in; accent-insensitive (`telefono` matches `teléfono`).
- **formatMoney:** PHP, USD with decimals, unknown currency, null.
- **fire:**
  - fires once and stays quiet while the price is unchanged;
  - re-fires on a price change with a `was` reason;
  - fires again after the rule turns false then true;
  - `new` only via `newIds`;
  - inputs are not mutated.
- **buildCommand:**
  - darwin args carry a title containing `" & end tell` exactly as an argument, not inside a script;
  - win32 env carries the text, and `WIN_TOAST_SCRIPT` doesn't contain it;
  - control characters are stripped; truncation; null for `aix`.
- **alertsToNotifications:** ≤3 alerts and 5 alerts (2 individual + summary `+3 more`).
- **notify:**
  - a fake `spawn` (an EventEmitter that emits `exit 0`) is called without `shell`;
  - a non-zero exit or an `error` event logs the fallback and doesn't throw;
  - a null platform logs.

---

## 5. Task C — infrastructure (plan §2, §5 daily cap, §6)

### 5.1 `src/config.js` and `.env.example`
Add to `config`:
- `maxDailyVisits`: `MAX_DAILY_VISITS`, default 60.
- `uiPort`: `UI_PORT`, default 5173.
- `marketLocation`: `MARKET_LOCATION`, default `''`. Empty means the profile's location; Pasig's value is set after the live step.
- `marketRadiusKm`: `MARKET_RADIUS_KM`, default 6.
- `marketCurrency`: `MARKET_CURRENCY`, default `'PHP'`.
- `outputDir`: `OUTPUT_DIR`, default `<repo>/output`, resolved from `import.meta.url`.

Document each in `.env.example` with a one-line comment, in the existing style.

### 5.2 `src/guard.js`: add `DailyBudget` (keep everything that's there)
```js
new DailyBudget({ dir, max, now = () => new Date() })
  .used()  → number     // reads <dir>/visits-YYYY-MM-DD.json (local date of now()); 0 if missing or unreadable
  .left()  → max - used() (never below 0)
  .spend() → void       // throws Error(`Daily visit cap of ${max} reached.`) if used() >= max; else writes { date, used: used+1 } atomically
```
Creates `dir` if it's missing. A new local date starts at 0.

### 5.3 `src/fb.js` (all selectors stay here)
- `constructor(page, budget, { daily } = {})`. `open()` calls `this.budget.spend()`, then `this.daily?.spend()`, **before** `goto`. Existing behavior is otherwise unchanged.
- `export function marketplaceSearchUrl(query, { location, minPrice, maxPrice, daysSinceListed, radiusKm } = {})`
  - Path: `https://www.facebook.com/marketplace/<encodeURIComponent(location)>/search` if `location`, else `https://www.facebook.com/marketplace/search`.
  - Params in this order, skipping null, undefined and `''`: `query`, `minPrice`, `maxPrice`, `daysSinceListed`, `radius` (= radiusKm), then always `sortBy=creation_time_descend` and `exact=false`.
  - Built with `URLSearchParams`.
- `async marketplaceSearch(query, filters)` → `this.open(marketplaceSearchUrl(query, filters))`.
- `async readListingCards(max = 40) → { href, text, img }[]`
  - Each round, collect `a[href*="/marketplace/item/"]`: absolute `href`, `innerText`, first `img` `src` or null. Dedupe by item id.
  - Stop at `max` cards, after 2 rounds in a row with no new cards, or after 10 scroll rounds. Between rounds: `scroll(this.page, { steps: 1 })`.
  - Returns at most `max`.
- `async readSearchArea() → string|null`: best-guess text of the location/radius chip on the results page (e.g. a short element containing `km`). null if not found. Never throws.
- `async readListingDetail(id)`
  - `this.open('/marketplace/item/<id>/')`, then returns raw `{ title, priceText, labelText, description, sellerName, postedText, condition }`.
  - Best guesses:
    - title: the first `h1`;
    - price: the first short text near it matching a currency;
    - posted: text starting `Listed `;
    - description: the text block after a `Details` / `Description` heading;
    - condition: the value after `Condition`;
    - seller: the name in the `Seller information` section;
    - label: a visible `Sold` / `Pending` badge.
  - Each field is null when not found. Only navigation errors throw.
- Mark the best-guess selectors with `// TUNE LIVE` comments.

### 5.4 `src/watch/store.js`
```js
export function createWatchId(query, now = new Date())   // `${YYYYMMDD}-${HHmmss}-${slug}` (local time)
  // slug: normalize NFD, strip marks, lowercase, non [a-z0-9] runs → '-', trim '-', max 40 chars, '' → 'watch'
export function isValidWatchId(id)                        // /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/
export class WatchStore {
  constructor(outputDir)              // watches live in <outputDir>/watches/<id>/
  create(watch)                       // mkdir; throws if the dir exists; writes watch.json
  readWatch(id) / writeWatch(watch)   // null if missing
  readListings(id) → {}  / writeListings(id, known)
  readAlertState(id) → {} / writeAlertState(id, state)
  appendPass(id, pass)    / readPasses(id)  → []
  appendEvents(id, evts)  / readEvents(id)  → []
  appendAlerts(id, alerts)/ readAlerts(id)  → []
  readReadIds(id) → Set   / markRead(id, ids) → number newly marked   // alerts-read.json { readIds: [...] }
  listWatchIds() → string[]           // valid ids that have watch.json, newest first
  acquireLock() → release()           // <outputDir>/watches/.lock { pid, startedAt }
}
```
- Every method taking `id` throws `Error('Invalid watch id')` if `!isValidWatchId(id)`.
- JSON writes are atomic. JSONL appends write one JSON object per line. Readers skip blank lines and a line that fails to parse (a partial last line).
- **acquireLock:**
  - If the lock exists and its pid is alive (`process.kill(pid, 0)` doesn't throw), throw `Error('Another watch is running (pid <pid>).')`.
  - A stale lock is replaced. Create with flag `wx`.
  - `release()` removes the lock only if it still holds our pid.

### 5.5 Tests: `test/store.test.js`, `test/daily.test.js`, `test/fb.test.js`
Must test:
- **createWatchId and isValidWatchId:** accents, symbols, an empty query, and length.
- **Store:**
  - every read and write pair round-trips;
  - reads of a missing watch return defaults;
  - an invalid id throws (`../x`);
  - a partial last JSONL line is skipped;
  - `markRead` unions ids and returns the new count;
  - `listWatchIds` order;
  - lock: the second acquire throws; a stale pid lock is replaced; release.
- **DailyBudget:** counts, the cap throws, a new day resets (fake `now`), and the file shape.
- **fb.test.js:**
  - `marketplaceSearchUrl` with and without location and with all filters;
  - `open()` spends the per-run budget and the daily budget before `goto`. Use a fake page whose `goto` records calls and whose `url()` returns `https://www.facebook.com/`. `pause()` reads config, so to keep the test fast, set `process.env.MIN_DELAY_MS = '0'` and `MAX_DELAY_MS = '0'` **before** a dynamic `import('../src/fb.js')`.

---

## 6. Task D — runner and CLIs (plan §1, §5). Starts after A, B and C are merged

### 6.1 `src/watch/args.js`
- `parseDuration(s) → ms`: `90s`, `30m`, `1h`, `1h30m`. Anything else throws `Error('Bad duration "<s>"')`.
- `parseUntil(s, now) → Date`
  - `HH:MM` (24h) → that time today, or tomorrow if it's not after `now`.
  - Otherwise, an ISO date-time via `Date.parse`.
  - Invalid → throws `Error('Bad --until "<s>"')`.
- `parseArgs(argv, { now = new Date(), config }) → WatchSpec`. Uses `node:util` `parseArgs` with `allowPositionals`. Positionals joined with spaces form the query. Options:
  - `--times`, `--every`;
  - `--until`;
  - `--min-price`, `--max-price`;
  - `--location`, `--radius`;
  - `--days`;
  - `--max-listings`, `--details`;
  - `--alert` (multiple);
  - `--no-desktop`.
- Validation (throw an `Error` with a clear message):
  - query not empty;
  - `times` 1–48;
  - `every` ≥ 10m (default 30m);
  - `until` ≥ now + 10m;
  - prices are integers ≥ 0, with min ≤ max;
  - `radius` > 0;
  - `days` a positive integer;
  - `max-listings` 1–100 (default 40);
  - `details` 0–20 (default 5).
- `times`:
  - given → as given;
  - else with `until` → `min(48, floor((until − now) / everyMs) + 1)`;
  - else 4.
- Defaults from `config`: `location = config.marketLocation || null`, `radiusKm = config.marketRadiusKm`, `currency = config.marketCurrency`.
- `alerts = parseRules(values.alert ?? [])`; `until` is stored as an ISO string or null.

### 6.2 `src/watch/runner.js`
- `detailsAllowed({ k, queued, left, searchesRemaining }) → max(0, min(k, queued, left − searchesRemaining))`. `searchesRemaining` counts this pass.
- `nextPassDelay(everyMs, rand = Math.random) → everyMs * (0.8 + 0.4 * rand())`.
- `skipQuietHours(date, startHour, endHour) → Date`: if `date` is in quiet hours (use `inQuietHours` from `human.js`), returns the next local `endHour:00`; else `date`.
- `async runWatch(spec, deps) → Watch`, with deps:
  - `{ store, daily, attach, makeFacebook(page, budget, daily), notify(alerts, spec), now(), sleep(ms), rand(), log, quiet: { start, end }, signal }`.
  - `attach() → { page, detach }`. `signal` is an optional `AbortSignal`.

  Steps:
  1. **Before anything:** if `daily.left() < spec.times`, throw `Error('Only <left> visits left today; <left> passes would fit.')` (with `<left>` 0 → "0 passes").
  2. **Create the watch:**
     - `id = createWatchId(spec.query, now())`;
     - `status 'running'`, `passesDone 0`, `passesTotal = spec.times`;
     - `nextPassAt` = now;
     - `lastError`, `searchArea` null; `detailsQueued` 0;
     - `store.create(...)`.
  3. **For pass n = 1..times:**
     - Wait until `skipQuietHours(nextPassAt)`. Use `deps.sleep(ms)` and log when skipping quiet hours.
     - If `signal?.aborted`, set status `stopped` and end.
     - If `spec.until` and the wait target is after `until`, set status `done` and end.
     - If `daily.left() < 1`, set status `stopped_budget` and end.
     - Before attaching: `k = detailsAllowed({ k: spec.detailsPerPass, queued: Infinity, left: daily.left(), searchesRemaining: times − n + 1 })`. The real queue is only known after the search, so the pass opens `min(k, queue.length)` details.
     - **Pass body:**
       - `const { page, detach } = await attach()`, then in `try { … } finally { await detach() }`:
         - `fb = makeFacebook(page, new Budget(1 + k), daily)`;
         - `marketplaceSearch(spec.query, spec.filters)`;
         - `searchArea = await fb.readSearchArea()`;
         - `raws = await fb.readListingCards(spec.maxListings)`;
         - `parseCard` each (with `{ currency: spec.currency }`), dropping nulls;
         - `diff`;
         - `queue = detailQueue(known, { isPriority: l => spec.alerts.some(r => cardMatches(r, l)) })`;
         - for each of the first `min(k, queue.length)` ids: `readListingDetail`, `parseDetail`, `applyDetail`.
       - Collect events in order.
     - **After the pass:**
       - `newIds` = ids of `new` events;
       - `fire(spec.alerts, known, state, { pass: n, at, watchId, newIds })`;
       - write listings, alert state, events, alerts and a `Pass` record (`visits = 1 + detailsOpened`);
       - update the watch: `passesDone`, `searchArea`, `detailsQueued = detailQueue(known).length`, `nextPassAt = now + nextPassDelay`;
       - log a one-line summary plus one line per alert;
       - if there are alerts and `spec.desktop`, `await deps.notify(alerts, spec)` in a try/catch.
     - **Errors in the pass body** (message matching):
       - `/Checkpoint not cleared/` → status `stopped_checkpoint`, end.
       - `/Daily visit cap/` → `stopped_budget`, end.
       - Anything else → a failed `Pass` (`ok: false, error: message`), `lastError` set, the consecutive-failure count goes up. At 2 → status `error`, end. Otherwise schedule the next pass as usual.
     - Abort after the body → status `stopped`.
  4. **End:** status `done` if the loop finished. Write the watch and return it.

### 6.3 `src/watch.js` (`npm run watch`)
- Parse args. On error: print the message plus a usage line, exit 2.
- `store = new WatchStore(config.outputDir)`, then `release = store.acquireLock()`. On error: print and exit 1.
- **Real deps:**
  - `attach` from `browser.js`;
  - `makeFacebook = (page, budget, daily) => new Facebook(page, budget, { daily })`;
  - `daily = new DailyBudget({ dir: config.outputDir, max: config.maxDailyVisits })`;
  - `notify = (alerts, spec) => notify(alertsToNotifications(alerts, { query: spec.query }))`;
  - real clock; `sleep` that resolves early on abort;
  - `quiet` from config.
- SIGINT → `AbortController.abort()`. The second SIGINT exits at once.
- Print the watch id, `npm run ui` hint, and the final status. Release the lock in `finally`.

### 6.4 `src/market.js` (`npm run market`)
- One pass using the same arg parser (ignores `--times`, `--until`, `--every`; `--details` defaults to 1 here).
- Attaches; uses `DailyBudget`. Prints:
  - the search URL;
  - `searchArea`;
  - the parsed listings as one line each: `price · title · location · id`;
  - the parsed detail for the first k.
- Writes nothing to `output/watches`. For the live selector-tuning step it also prints the raw card text of the first 3 cards when `--raw` is given.

### 6.5 `package.json`
Add scripts:
- `"watch": "node src/watch.js"`
- `"market": "node src/market.js"`
- `"ui": "node src/server.js"`

Nothing else changes.

### 6.6 Tests: `test/args.test.js`, `test/runner.test.js`
Must test:
- **parseDuration:** all forms plus errors.
- **parseUntil:** later today, already past → tomorrow, ISO, invalid.
- **parseArgs:**
  - defaults;
  - `--until` alone computes times;
  - both `--until` and `--times`;
  - each validation error;
  - repeated `--alert`;
  - `--no-desktop`;
  - config defaults applied.
- **detailsAllowed:** reserve math, including the plan's 60/17 example.
- **nextPassDelay:** bounds.
- **skipQuietHours:** inside and outside the window.
- **runWatch**, with a fake fb (scripted cards per pass), fake attach (counts detach), a real `WatchStore` on a tmp dir, a fake daily, fake clock and sleep:
  - 3 passes produce baseline / new / price-drop events and an alert, and `notify` is called;
  - details are opened in queue order up to k;
  - not enough daily visits at start throws;
  - the checkpoint error stops with `stopped_checkpoint`;
  - 2 consecutive generic failures → `error`;
  - one failure then success continues;
  - `until` stops early;
  - abort → `stopped`;
  - `detach` is called on every pass, including failures.

---

## 7. Task E — local server and frontend (plan §7, §8). Starts after C is merged

### 7.1 `src/server.js` (`npm run ui`)
- `export function createServer({ store, publicDir }) → http.Server` (not listening).
- When run directly (`import.meta.url === pathToFileURL(process.argv[1]).href`): listen on `127.0.0.1:${config.uiPort}` and print the URL.
- **Every request:** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, where port is `server.address().port`. Otherwise → 403 `{ error: 'Bad host' }`.
- **Headers on every response:**
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Content-Security-Policy: default-src 'self'; img-src 'self' https://*.fbcdn.net data:; style-src 'self'; script-src 'self'; connect-src 'self'`
- **JSON errors:** `{ error }`, with status 400, 403, 404 or 405.
- **Routes:**

| Route | Response |
|---|---|
| `GET /api/watches` | `[{ id, query, status, passesDone, passesTotal, until, nextPassAt, filters, searchArea, lastError, counts: { total, active, sold, pending, missing, new, priceDrops }, unreadAlerts }]`. The order follows `listWatchIds`. `new` and `priceDrops` count events of those types |
| `GET /api/watches/:id` | `{ watch, listings: [...] (sorted by firstSeen.pass, then id), passes, detailsQueued }`. 404 if the id is invalid or unknown |
| `GET /api/watches/:id/events?since=<iso>&limit=<n>` | Events with `at > since`, newest first, limit default 200, max 1000 |
| `GET /api/alerts?unread=1&watch=<id>` | Alerts (all watches, or one), each `{ ...alert, read }`, newest first, max 500 |
| `POST /api/alerts/read` | Checks below. Body `{ watch, ids: [...] }` or `{ watch, all: true }`. → `{ ok: true, marked }` |
| `GET /` | `public/index.html` |
| `GET /static/<name>` | `<name>` must match `^[a-z0-9_-]+\.(js|css|svg)$`; served from `publicDir` with the right content type. Else 404 |

- **POST `/api/alerts/read` checks:**
  - `Content-Type` starts with `application/json`;
  - `Origin` equals `http://127.0.0.1:<port>` or `http://localhost:<port>` (a missing Origin → 403);
  - body ≤ 10 KB;
  - `watch` valid and existing.

### 7.2 `public/index.html`, `public/app.js`, `public/style.css`
- `index.html` loads `/static/style.css` and `<script type="module" src="/static/app.js">`. No inline scripts or styles (CSP).
- **Hash routes:** `#/` (watches), `#/watch/<id>`, `#/alerts`.
- **Build the DOM only with `createElement` / `textContent` / `setAttribute`.** Never `innerHTML` with data: listing titles are untrusted.
- **Money:** `Intl.NumberFormat('en-PH', { style: 'currency', currency })` on `amount / 100`. Times are shown in local time.
- **Watches page:**
  - one row per watch: query, status, `passesDone/passesTotal`, `until HH:MM` if set, next-pass countdown, counts, unread alerts;
  - click → watch page.
- **Watch page:**
  - **Header:** query, `searchArea` (shown as-is, with a warning badge if it's null), status, progress, until, next pass, `detailsQueued`, rule chips (`rule.text`).
  - **Listings table:**
    - columns: image (`img` with `referrerpolicy="no-referrer"` and a placeholder `onerror` set in JS), title linking to `url` (`target="_blank" rel="noopener noreferrer"`), price, change since first seen, status badge, alerted mark, location, first seen, last seen;
    - sort: price, newest, biggest drop;
    - filter: status (all / active / new this pass / dropped / sold / missing / alerted) and price min/max.
  - **Price history:** an inline SVG sparkline per listing (`createElementNS`), shown when there are ≥2 points.
  - **Events timeline:** grouped by pass, with readable text (e.g. `₱2,000 drop: <title>`).
  - **Pass log:** time, cards read, details opened, visits, error.
- **Alerts page:**
  - list newest first: time, watch query, `ruleText`, listing link, price (was), reason;
  - unread styled;
  - "Mark read" per row and "Mark all read" per watch, via POST with `Content-Type: application/json`.
- **On every page:** an unread badge linking to `#/alerts`, and `document.title` = `(n) pst` when n > 0, else `pst`.
- **Polling:** every 15 s, the current view and `/api/alerts?unread=1`, only while `document.visibilityState === 'visible'`.
- Plain, readable CSS. Light theme, plus dark via `prefers-color-scheme`.

### 7.3 Tests: `test/server.test.js`
- Real `WatchStore` on a tmp dir, seeded with a made-up watch, listings, events, passes and alerts.
- `createServer(...).listen(0, '127.0.0.1')`; requests via `fetch` with an explicit `Host`.

Must test:
- summaries and counts;
- watch detail;
- events `since` and `limit`;
- alerts with the `unread` filter and the `watch` filter;
- mark read by ids and `all`;
- 403 for a bad Host, a missing or foreign Origin, and a wrong content type;
- 404 for `../` ids and bad static names;
- index and a static file served with CSP;
- 405 for a wrong method on an API route.

(Node's `fetch` doesn't let you set `Host`; use `http.request` for those cases.)

The frontend has no automated tests in this run. V loads it against the seeded store to smoke test it.

---

## 8. File ownership

| Task | Owns (create or edit) |
|---|---|
| A | `src/market/parse.js`, `src/watch/diff.js`, `test/parse.test.js`, `test/diff.test.js` |
| B | `src/alerts/rules.js`, `src/alerts/notify.js`, `test/rules.test.js`, `test/notify.test.js` |
| C | `src/config.js`, `.env.example`, `src/guard.js`, `src/fb.js`, `src/watch/store.js`, `test/store.test.js`, `test/daily.test.js`, `test/fb.test.js` |
| D | `src/watch/args.js`, `src/watch/runner.js`, `src/watch.js`, `src/market.js`, `package.json` (scripts only), `test/args.test.js`, `test/runner.test.js` |
| E | `src/server.js`, `public/index.html`, `public/app.js`, `public/style.css`, `test/server.test.js` |
| V (verify) | `README.md`, `docs/plans/marketplace-watch.md` (status), `docs/plans/setup.md`, this file's §11, `docs/plans/mw-workflow.md` result |

A change to a file you don't own is a contract issue, not an edit. Existing tests (`test/guard.test.js`, `test/platform.test.js`) must keep passing, and nobody edits them.

## 9. Gate (run per branch by the orchestrator before each merge, in the integration worktree after merge too)

```sh
npm test                                                     # all green
for f in $(git diff --name-only <base>...HEAD -- '*.js'); do node --check "$f"; done
git diff <base>...HEAD -- package.json                       # D only: scripts added, dependencies unchanged; others: empty
git diff --name-only <base>...HEAD                           # every path in the task's ownership row
grep -rn "innerHTML" public/ && exit 1 || true               # E only: no innerHTML
```

Merge only on green.

## 10. Definition of Done (V checks each)

- [ ] All §3–§7 must-tests exist and pass. `npm test` is green on the integration branch with the old tests unchanged.
- [ ] No new dependencies; `package-lock.json` unchanged.
- [ ] `npm run watch -- --help`-style misuse (no query) prints usage and exits 2, without attaching.
- [ ] `npm run ui` against a seeded tmp `OUTPUT_DIR` serves every page:
  - watches, watch view, alerts;
  - mark-read works;
  - no console errors;
  - a listing title containing `<img src=x onerror=alert(1)>` renders as text.
- [ ] Nothing in the diff connects to port 9222 except through `attach()`. No real notifications are sent in tests. No `.env` is read by any test.
- [ ] Every selector is in `src/fb.js`, and the best guesses are marked `// TUNE LIVE`.
- [ ] README updated: the new commands, alert syntax, `.env` keys, and the live step still to do. The plan's status is updated.
- [ ] Review (Opus) done: injection (notifications, server paths, DOM), localhost hardening, visit budget, lock handling, privacy in logs and fixtures.

## 11. Defaults chosen by the planner (changeable before or after the run)

1. `MARKET_LOCATION` defaults to empty (the profile's location) until the live step finds Pasig's slug or id; then it becomes the code default.
2. `MAX_DAILY_VISITS` 60, `--details` 5, `--max-listings` 40, `--every` 30m, minimum interval 10m, jitter ±20%.
3. "Missing" after 2 misses, counting a miss only when the results ran out or the listing ranked in the top 75%.
4. At most 3 desktop notifications per pass.
5. Store is JSON in `output/` (D-005). Read marks are per watch.
6. UI on port 5173, `127.0.0.1` only. CSP allows images from `*.fbcdn.net`.

## 12. Contract issues reported by builders
_(filled in during the run; only ones that changed behaviour)_

Decided by V (Opus 5.5), 2026-11-14. The builder's choice was accepted unless marked otherwise. Gaps that were filled the obvious way and add no behaviour (prevPrice without `raw`, `reason: ''` on a non-match, fb.js keeping its own item-id regex, guard.js keeping its own atomic write, `create()` rejecting a bad id like every other method, the `ui` script landing before E) are not listed.

| # | Task / § | Decision (now part of the contract) |
|---|---|---|
| 1 | A §2, §3.2 | `lastRank` is the index among the **deduplicated** cards of the pass, so a duplicate never shifts another listing's rank. |
| 2 | A §3.2 | Two non-null amounts in **different currencies**: no event, and the stored price is kept. |
| 3 | A §3.2 | A known listing seen with a **null price** keeps its stored price. A null observation never clears an amount. |
| 4 | A §3.1 | `parsePrice` matches `Free` as a whole token anywhere in the text, taking the earliest match. `parseCard` only calls it on whole lines, so card parsing is unaffected. |
| 5 | B §4.1 | On a first fire, `prevPrice` is null when the second-to-last `priceHistory` amount is null. |
| 6 | B §4.1 | `drop>=0` is rejected like `drop>=0%`. `price<N`, `price<=N` and `drop>=N` take **whole units only**, so decimals are an error. |
| 7 | B §4.2 | The `notify` log fallback strips control characters from the title and body before logging them, then appends `\x07`. This stops terminal escape injection from listing titles. |
| 8 | C §5.4 | A corrupt `watch.json`, `listings.json`, `alertState.json` or `alerts-read.json` throws the JSON parse error. The UI answers 500, and for `/api/watches` that means the whole list fails, not just that watch. Accepted for now: writes are atomic, so this needs outside damage. JSONL readers skip bad lines as specced. |
| 9 | D §1, §10 | **Changed by V:** `src/config.js` now skips `dotenv` when `NODE_TEST_CONTEXT` is set (set by `node --test` in every test process). The DoD line "no `.env` is read by any test" now holds for every test, the old `guard.test.js` included. Direct runs still read `.env`. |
| 10 | D §6.1 | `--help` / `-h` print usage and exit 0 (`watch` and `market`). A missing query exits 2. Query whitespace is collapsed. |
| 11 | D §6.1 | `parseUntil` needs a `YYYY-MM-DD` prefix before `Date.parse` (V8 accepts loose strings such as `foo 12`). |
| 12 | D §6.2 | `passesDone` counts every finished pass, failed ones included. `nextPassAt` is null after the last pass and after any stop or error. Checkpoint, budget and generic failures each write a `Pass` with `ok: false`. `cardsRead` is the raw card count, so the results-ran-out rule uses the raw count. The runner logs `Watch <id> started` when it creates the watch. |
| 13 | D §6.4 | `market` refuses to run during quiet hours (exit 0 with a message), like `index.js`. |
| 14 | E §7.1 | `POST /api/alerts/read` drops ids that aren't alerts of that watch, and `marked` counts only real alerts. |
| 15 | E §7.1 | A bad `since` or `limit`, bad JSON, a bad body or a body over 10 KB → 400 `{ error }`. An unexpected exception → 500 `{ error: 'Server error' }`. |
| 16 | E §7.1 | `server.js` imports `config.js` dynamically, and only when run directly. |
| 17 | E §7.2 | The watch page gets the alerted mark from `/api/alerts?watch=<id>` (listings whose id appears in an alert's `listingId`). |
| 18 | A, C, E commits | The builder commits carry a `Claude Haiku 5.5` trailer because the session's attribution reminder said so. That's accurate, since Haiku workers built them. History is left as is, and V's commit carries the Opus trailer. |
