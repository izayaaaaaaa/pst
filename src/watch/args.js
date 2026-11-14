// CLI argument parsing for `npm run watch` and `npm run market`. Pure: config and the clock
// are passed in, so nothing here reads .env or the system time on its own.
import { parseArgs as nodeParseArgs } from 'node:util';
import { parseRules } from '../alerts/rules.js';

const MIN_EVERY_MS = 10 * 60_000;
const DEFAULT_EVERY_MS = 30 * 60_000;
const MAX_TIMES = 48;
const DEFAULT_TIMES = 4;

/**
 * Parse a duration like `90s`, `30m`, `1h` or `1h30m`.
 * @param {string} s
 * @returns {number} milliseconds
 */
export function parseDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(s));
  if (!m || !(m[1] || m[2] || m[3])) throw new Error(`Bad duration "${s}"`);
  const [h = 0, min = 0, sec = 0] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  return ((h * 60 + min) * 60 + sec) * 1000;
}

/**
 * Parse `--until`: `HH:MM` (24h) means that time today, or tomorrow if it isn't after `now`.
 * Anything else must be an ISO date-time.
 * @param {string} s
 * @param {Date} now
 * @returns {Date}
 */
export function parseUntil(s, now) {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (hm) {
    const h = Number(hm[1]);
    const min = Number(hm[2]);
    if (h > 23 || min > 59) throw new Error(`Bad --until "${s}"`);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new Error(`Bad --until "${s}"`);
}

/** Whole number from text, commas allowed (e.g. "25,000"), within [min, max]. */
function parseInteger(value, flag, min, max) {
  const digits = String(value).replace(/,/g, '');
  const n = /^\d+$/.test(digits) ? Number(digits) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    const range = max === Infinity ? `${min} or more` : `${min} to ${max}`;
    throw new Error(`${flag} must be a whole number, ${range}. Got "${value}".`);
  }
  return n;
}

/**
 * Parse watch/market arguments into a WatchSpec. Throws an Error with a plain message on bad input.
 * @param {string[]} argv arguments after the script name
 * @param {{ now?: Date, config?: { marketLocation?: string, marketRadiusKm?: number, marketCurrency?: string } }} [opts]
 * @returns {{ query: string, filters: object, times: number, until: string|null, everyMs: number,
 *             maxListings: number, detailsPerPass: number, alerts: object[], desktop: boolean, currency: string }}
 */
export function parseArgs(argv, { now = new Date(), config = {} } = {}) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        times: { type: 'string' },
        every: { type: 'string' },
        until: { type: 'string' },
        'min-price': { type: 'string' },
        'max-price': { type: 'string' },
        location: { type: 'string' },
        radius: { type: 'string' },
        days: { type: 'string' },
        'max-listings': { type: 'string' },
        details: { type: 'string' },
        alert: { type: 'string', multiple: true },
        'no-desktop': { type: 'boolean' },
      },
    });
  } catch (err) {
    throw new Error(err.message);
  }
  const { values, positionals } = parsed;

  // Query
  const query = positionals.join(' ').replace(/\s+/g, ' ').trim();
  if (!query) throw new Error('A search query is required, e.g. npm run watch -- "test phone 128gb"');

  // Interval and schedule
  const everyMs = values.every !== undefined ? parseDuration(values.every) : DEFAULT_EVERY_MS;
  if (everyMs < MIN_EVERY_MS) throw new Error('--every must be at least 10m');

  const until = values.until !== undefined ? parseUntil(values.until, now) : null;
  if (until && until.getTime() < now.getTime() + MIN_EVERY_MS) {
    throw new Error(`--until must be at least 10m from now. Got "${values.until}".`);
  }

  let times;
  if (values.times !== undefined) {
    times = parseInteger(values.times, '--times', 1, MAX_TIMES);
  } else if (until) {
    times = Math.min(MAX_TIMES, Math.floor((until.getTime() - now.getTime()) / everyMs) + 1);
  } else {
    times = DEFAULT_TIMES;
  }

  // Search filters (whole units, like Facebook's URL)
  const minPrice = values['min-price'] !== undefined ? parseInteger(values['min-price'], '--min-price', 0, Infinity) : null;
  const maxPrice = values['max-price'] !== undefined ? parseInteger(values['max-price'], '--max-price', 0, Infinity) : null;
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    throw new Error('--min-price is more than --max-price');
  }

  const location =
    values.location !== undefined ? values.location.trim() || null : config.marketLocation || null;

  let radiusKm = config.marketRadiusKm ?? 6;
  if (values.radius !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(values.radius) || Number(values.radius) <= 0) {
      throw new Error(`--radius must be a number above 0. Got "${values.radius}".`);
    }
    radiusKm = Number(values.radius);
  }

  const daysSinceListed =
    values.days !== undefined ? parseInteger(values.days, '--days', 1, Infinity) : null;

  // Pass sizing
  const maxListings = values['max-listings'] !== undefined ? parseInteger(values['max-listings'], '--max-listings', 1, 100) : 40;
  const detailsPerPass = values.details !== undefined ? parseInteger(values.details, '--details', 0, 20) : 5;

  const alerts = parseRules(values.alert ?? []);

  return {
    query,
    filters: { minPrice, maxPrice, location, radiusKm, daysSinceListed },
    times,
    until: until ? until.toISOString() : null,
    everyMs,
    maxListings,
    detailsPerPass,
    alerts,
    desktop: !values['no-desktop'],
    currency: config.marketCurrency || 'PHP',
  };
}
