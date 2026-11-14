import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseUntil, parseArgs } from '../src/watch/args.js';

// All data here is made up. Config is passed in explicitly; nothing reads .env.
const NOW = new Date(2026, 10, 14, 9, 0, 0); // local 09:00
const CONFIG = { marketLocation: '', marketRadiusKm: 6, marketCurrency: 'PHP' };
const parse = (argv, config = CONFIG) => parseArgs(argv, { now: NOW, config });

describe('parseDuration', () => {
  test('accepts every form', () => {
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('1h30m15s'), 5_415_000);
  });

  test('rejects anything else', () => {
    for (const bad of ['30', '', '1d', 'abc', '1h 30m', '-5m']) {
      assert.throws(() => parseDuration(bad), /Bad duration/, bad);
    }
  });
});

describe('parseUntil', () => {
  test('HH:MM later today stays today', () => {
    const d = parseUntil('18:00', NOW);
    assert.equal(d.getTime(), new Date(2026, 10, 14, 18, 0, 0).getTime());
  });

  test('HH:MM already past means tomorrow', () => {
    const d = parseUntil('08:30', NOW);
    assert.equal(d.getTime(), new Date(2026, 10, 15, 8, 30, 0).getTime());
  });

  test('an ISO date-time is used as given', () => {
    const d = parseUntil('2026-11-15T10:00:00Z', NOW);
    assert.equal(d.toISOString(), '2026-11-15T10:00:00.000Z');
  });

  test('invalid input throws', () => {
    for (const bad of ['soon', '25:00', '18:61', '']) {
      assert.throws(() => parseUntil(bad, NOW), /Bad --until/, bad);
    }
  });
});

describe('parseArgs', () => {
  test('defaults', () => {
    const spec = parse(['test phone 128gb']);
    assert.equal(spec.query, 'test phone 128gb');
    assert.equal(spec.times, 4);
    assert.equal(spec.everyMs, 30 * 60_000);
    assert.equal(spec.until, null);
    assert.equal(spec.maxListings, 40);
    assert.equal(spec.detailsPerPass, 5);
    assert.equal(spec.desktop, true);
    assert.equal(spec.currency, 'PHP');
    assert.deepEqual(spec.alerts, []);
    assert.deepEqual(spec.filters, {
      minPrice: null,
      maxPrice: null,
      location: null,
      radiusKm: 6,
      daysSinceListed: null,
    });
  });

  test('positionals join into the query', () => {
    assert.equal(parse(['test', 'phone', '  128gb ']).query, 'test phone 128gb');
  });

  test('an empty query is an error', () => {
    assert.throws(() => parse([]), /query is required/);
    assert.throws(() => parse(['--times', '2']), /query is required/);
  });

  test('--until alone computes times (9:00 to 18:00 at 30m = 18 intervals, 19 passes)', () => {
    const spec = parse(['phone', '--until', '18:00']);
    assert.equal(spec.times, 19);
    assert.equal(spec.until, new Date(2026, 10, 14, 18, 0, 0).toISOString());
  });

  test('--until computes times capped at 48', () => {
    const spec = parse(['phone', '--until', '2026-11-30T09:00:00', '--every', '10m']);
    assert.equal(spec.times, 48);
  });

  test('--until together with --times uses --times', () => {
    const spec = parse(['phone', '--until', '18:00', '--times', '3']);
    assert.equal(spec.times, 3);
  });

  test('--until too close to now is an error', () => {
    assert.throws(() => parse(['phone', '--until', '09:05']), /at least 10m from now/);
  });

  test('--every: minimum 10m, default 30m', () => {
    assert.equal(parse(['phone', '--every', '10m']).everyMs, 10 * 60_000);
    assert.throws(() => parse(['phone', '--every', '5m']), /at least 10m/);
    assert.throws(() => parse(['phone', '--every', 'x']), /Bad duration/);
  });

  test('--times: 1 to 48', () => {
    assert.equal(parse(['phone', '--times', '1']).times, 1);
    assert.equal(parse(['phone', '--times', '48']).times, 48);
    assert.throws(() => parse(['phone', '--times', '0']), /--times/);
    assert.throws(() => parse(['phone', '--times', '49']), /--times/);
    assert.throws(() => parse(['phone', '--times', '2.5']), /--times/);
  });

  test('prices are whole units, commas allowed, min must not exceed max', () => {
    const spec = parse(['phone', '--min-price', '5,000', '--max-price', '25000']);
    assert.equal(spec.filters.minPrice, 5000);
    assert.equal(spec.filters.maxPrice, 25000);
    assert.throws(() => parse(['phone', '--max-price', 'abc']), /--max-price/);
    assert.throws(() => parse(['phone', '--min-price', '30000', '--max-price', '20000']), /more than --max-price/);
  });

  test('--radius must be above 0', () => {
    assert.equal(parse(['phone', '--radius', '2.5']).filters.radiusKm, 2.5);
    assert.throws(() => parse(['phone', '--radius', '0']), /--radius/);
    assert.throws(() => parse(['phone', '--radius', '-1']), /unknown option|--radius/i);
  });

  test('--days is a positive integer', () => {
    assert.equal(parse(['phone', '--days', '7']).filters.daysSinceListed, 7);
    assert.throws(() => parse(['phone', '--days', '0']), /--days/);
  });

  test('--max-listings: 1 to 100', () => {
    assert.equal(parse(['phone', '--max-listings', '100']).maxListings, 100);
    assert.throws(() => parse(['phone', '--max-listings', '0']), /--max-listings/);
    assert.throws(() => parse(['phone', '--max-listings', '101']), /--max-listings/);
  });

  test('--details: 0 to 20', () => {
    assert.equal(parse(['phone', '--details', '0']).detailsPerPass, 0);
    assert.equal(parse(['phone', '--details', '20']).detailsPerPass, 20);
    assert.throws(() => parse(['phone', '--details', '21']), /--details/);
  });

  test('repeated --alert builds rules r1, r2 in order', () => {
    const spec = parse(['phone', '--alert', 'price<20000', '--alert', 'drop>=2000 & new']);
    assert.deepEqual(
      spec.alerts.map((r) => [r.id, r.text]),
      [
        ['r1', 'price<20000'],
        ['r2', 'drop>=2000 & new'],
      ],
    );
  });

  test('a bad --alert is an error', () => {
    assert.throws(() => parse(['phone', '--alert', 'foo']), /Bad alert rule/);
  });

  test('--no-desktop turns OS notifications off', () => {
    assert.equal(parse(['phone', '--no-desktop']).desktop, false);
  });

  test('config defaults apply, and --location "" means the profile location', () => {
    const cfg = { marketLocation: 'Test Town', marketRadiusKm: 3, marketCurrency: 'USD' };
    const spec = parse(['phone'], cfg);
    assert.equal(spec.filters.location, 'Test Town');
    assert.equal(spec.filters.radiusKm, 3);
    assert.equal(spec.currency, 'USD');
    assert.equal(parse(['phone', '--location', ''], cfg).filters.location, null);
    assert.equal(parse(['phone', '--location', 'Other Town'], cfg).filters.location, 'Other Town');
  });

  test('unknown options are an error', () => {
    assert.throws(() => parse(['phone', '--nope']), /nope/);
  });
});
