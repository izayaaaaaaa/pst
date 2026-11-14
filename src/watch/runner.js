// Watch runner: spaced search passes over one query. Each pass reads cards, diffs them against
// the stored listings, opens the top details, fires alert rules and persists the result.
// Side effects (browser, store, daily budget, clock, sleep, notifications) come in through `deps`,
// so the whole loop runs on fakes in tests.
import { Budget } from '../guard.js';
import { inQuietHours } from '../human.js';
import { createWatchId } from './store.js';
import { diff, applyDetail, detailQueue } from './diff.js';
import { parseCard, parseDetail } from '../market/parse.js';
import { cardMatches, fire, formatMoney } from '../alerts/rules.js';

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Details this pass may open: the plan's cap, the queue, and what's left of today's visits
 * after reserving one visit for each remaining search (D-007).
 * @param {{ k: number, queued: number, left: number, searchesRemaining: number }} p
 * @returns {number}
 */
export function detailsAllowed({ k, queued, left, searchesRemaining }) {
  return Math.max(0, Math.min(k, queued, left - searchesRemaining));
}

/**
 * Delay to the next pass: ±20% around `everyMs`.
 * @param {number} everyMs
 * @param {() => number} [rand]
 * @returns {number} milliseconds
 */
export function nextPassDelay(everyMs, rand = Math.random) {
  return everyMs * (0.8 + 0.4 * rand());
}

/**
 * If `date` is in quiet hours, the next local `endHour:00`. Otherwise `date` itself.
 * @param {Date} date
 * @param {number} startHour
 * @param {number} endHour
 * @returns {Date}
 */
export function skipQuietHours(date, startHour, endHour) {
  if (!inQuietHours(date.getHours(), startHour, endHour)) return date;
  const next = new Date(date);
  next.setHours(endHour, 0, 0, 0);
  if (next <= date) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Run one watch to completion (or until it stops early).
 * @param {object} spec WatchSpec from parseArgs
 * @param {{
 *   store: import('./store.js').WatchStore,
 *   daily: { left(): number, spend(): void },
 *   attach: () => Promise<{ page: object, detach: () => Promise<void> | void }>,
 *   makeFacebook: (page: object, budget: Budget, daily: object) => object,
 *   notify: (alerts: object[], spec: object) => Promise<void> | void,
 *   now: () => Date,
 *   sleep: (ms: number) => Promise<void>,
 *   rand: () => number,
 *   log: (line: string) => void,
 *   quiet: { start: number, end: number },
 *   signal?: AbortSignal,
 * }} deps
 * @returns {Promise<object>} the final watch record
 */
export async function runWatch(spec, deps) {
  const { store, daily, attach, makeFacebook, notify, now, sleep, rand, log, quiet, signal } = deps;
  const aborted = () => signal?.aborted === true;

  const left = daily.left();
  if (left < spec.times) {
    throw new Error(`Only ${left} visits left today; ${left} passes would fit.`);
  }

  const createdAt = now();
  const id = createWatchId(spec.query, createdAt);
  const watch = {
    ...spec,
    id,
    createdAt: createdAt.toISOString(),
    status: 'running',
    passesDone: 0,
    passesTotal: spec.times,
    nextPassAt: createdAt.toISOString(),
    lastError: null,
    searchArea: null,
    detailsQueued: 0,
  };
  store.create(watch);
  log(`Watch ${id} started: ${spec.times} passes${spec.until ? `, until ${spec.until}` : ''}.`);

  let known = {};
  let alertState = {};
  let consecutiveFailures = 0;

  try {
    for (let n = 1; n <= spec.times; n++) {
      if (aborted()) {
        watch.status = 'stopped';
        break;
      }

      // Wait for the next pass, moved out of quiet hours.
      const scheduled = new Date(watch.nextPassAt);
      const target = skipQuietHours(scheduled, quiet.start, quiet.end);
      if (target.getTime() !== scheduled.getTime()) {
        log(`Quiet hours: pass ${n} moved to ${hhmm(target)}.`);
      }
      if (spec.until && target > new Date(spec.until)) {
        watch.status = 'done';
        log(`Until ${spec.until} reached before pass ${n}; stopping.`);
        break;
      }
      watch.nextPassAt = target.toISOString();
      store.writeWatch(watch);
      const wait = target.getTime() - now().getTime();
      if (wait > 0) await sleep(wait);
      if (aborted()) {
        watch.status = 'stopped';
        break;
      }
      if (daily.left() < 1) {
        watch.status = 'stopped_budget';
        log('Daily visit cap reached; stopping.');
        break;
      }

      // Details: the plan's cap, limited by what's left after reserving the remaining searches.
      const k = detailsAllowed({
        k: spec.detailsPerPass,
        queued: Infinity,
        left: daily.left(),
        searchesRemaining: spec.times - n + 1,
      });
      const at = now().toISOString();
      const stats = { seenIds: [], cardsRead: 0, detailsOpened: 0, searchArea: null };
      let outcome;

      try {
        const { page, detach } = await attach();
        try {
          const fb = makeFacebook(page, new Budget(1 + k), daily);
          await fb.marketplaceSearch(spec.query, spec.filters);
          stats.searchArea = await fb.readSearchArea();
          const raws = await fb.readListingCards(spec.maxListings);
          stats.cardsRead = raws.length;
          const cards = raws.map((raw) => parseCard(raw, { currency: spec.currency })).filter(Boolean);
          stats.seenIds = cards.map((c) => c.id);

          const first = diff(known, cards, {
            pass: n,
            at,
            maxListings: spec.maxListings,
            cardsRead: raws.length,
          });
          let working = first.known;
          const events = [...first.events];

          const queue = detailQueue(working, {
            isPriority: (listing) => spec.alerts.some((rule) => cardMatches(rule, listing)),
          });
          for (const listingId of queue.slice(0, Math.min(k, queue.length))) {
            stats.detailsOpened += 1;
            const raw = await fb.readListingDetail(listingId);
            const applied = applyDetail(working, listingId, parseDetail(raw, { currency: spec.currency }), {
              pass: n,
              at,
            });
            working = applied.known;
            events.push(...applied.events);
          }
          outcome = { ok: true, known: working, events };
        } finally {
          try {
            await detach();
          } catch (err) {
            log(`Could not close the Chrome tab cleanly: ${err.message}`);
          }
        }
      } catch (err) {
        outcome = { ok: false, error: err?.message ?? String(err) };
      }

      const visits = 1 + stats.detailsOpened;
      const record = {
        n,
        startedAt: at,
        endedAt: now().toISOString(),
        ok: outcome.ok,
        error: outcome.ok ? null : outcome.error,
        seenIds: stats.seenIds,
        cardsRead: stats.cardsRead,
        detailsOpened: stats.detailsOpened,
        visits,
        searchArea: stats.searchArea,
      };
      watch.passesDone = n;

      if (!outcome.ok) {
        const msg = outcome.error;
        watch.lastError = msg;
        store.appendPass(id, record);
        if (/Checkpoint not cleared/.test(msg)) {
          watch.status = 'stopped_checkpoint';
          log(`Stopped at a Facebook checkpoint: ${msg}`);
          break;
        }
        if (/Daily visit cap/.test(msg)) {
          watch.status = 'stopped_budget';
          log(`Stopped: ${msg}`);
          break;
        }
        consecutiveFailures += 1;
        log(`Pass ${n}/${spec.times} failed: ${msg}`);
        if (consecutiveFailures >= 2) {
          watch.status = 'error';
          break;
        }
      } else {
        const { events } = outcome;
        const newIds = events.filter((e) => e.type === 'new').map((e) => e.listingId);
        const fired = fire(spec.alerts, outcome.known, alertState, { pass: n, at, watchId: id, newIds });

        known = outcome.known;
        alertState = fired.state;
        consecutiveFailures = 0;
        store.writeListings(id, known);
        store.writeAlertState(id, alertState);
        store.appendEvents(id, events);
        store.appendAlerts(id, fired.alerts);
        store.appendPass(id, record);

        const count = (type) => events.filter((e) => e.type === type).length;
        watch.searchArea = stats.searchArea;
        watch.detailsQueued = detailQueue(known).length;
        watch.lastError = null;
        log(
          `Pass ${n}/${spec.times}: ${stats.cardsRead} cards, ${count('new')} new, ` +
            `${count('price_drop')} price drops, ${stats.detailsOpened} details, ${visits} visits.`,
        );
        for (const alert of fired.alerts) {
          log(`  ALERT ${alert.title} (${formatMoney(alert.price)}): ${alert.reason}`);
        }
        if (fired.alerts.length && spec.desktop) {
          try {
            await notify(fired.alerts, spec);
          } catch (err) {
            log(`Notification failed: ${err.message}`);
          }
        }
      }

      if (outcome.ok && aborted()) watch.status = 'stopped';
      // Schedule the next pass, unless this was the last one or the watch has stopped.
      const more = n < spec.times && watch.status === 'running';
      watch.nextPassAt = more
        ? new Date(now().getTime() + nextPassDelay(spec.everyMs, rand)).toISOString()
        : null;
      store.writeWatch(watch);
      if (watch.status !== 'running') break;
    }
  } catch (err) {
    watch.status = 'error';
    watch.lastError = err.message;
    store.writeWatch(watch);
    throw err;
  }

  if (watch.status === 'running') watch.status = 'done';
  watch.detailsQueued = detailQueue(known).length;
  store.writeWatch(watch);
  return watch;
}
