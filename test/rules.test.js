import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, formatMoney, parseRule, parseRules, evaluate, cardMatches, fire,
} from '../src/alerts/rules.js';

// Made-up listing fixture (TrackedListing shape).
function listing(over = {}) {
  return {
    id: '1000000000000001',
    url: 'https://www.facebook.com/marketplace/item/1000000000000001/',
    title: 'Test Phone 128GB',
    image: null,
    location: 'Test City',
    price: { amount: 2500000, currency: 'PHP', raw: '₱25,000' },
    priceHistory: [
      { pass: 1, at: '2026-11-14T01:00:00.000Z', amount: 2750000 },
      { pass: 2, at: '2026-11-14T02:00:00.000Z', amount: 2500000 },
    ],
    firstSeen: { pass: 1, at: '2026-11-14T01:00:00.000Z' },
    lastSeen: { pass: 2, at: '2026-11-14T02:00:00.000Z' },
    lastRank: 0,
    missedPasses: 0,
    status: 'active',
    detail: null,
    ...over,
  };
}

test('normalizeText lowercases, strips accents and collapses spaces', () => {
  assert.equal(normalizeText('  Teléfono   NUEVO '), 'telefono nuevo');
});

test('parseRule handles every clause type', () => {
  const r = parseRule('price<25000 & price<=24,500 & drop>=2500 & drop>=10% & new & keyword:256gb & -keyword:icloud', 'r1');
  assert.equal(r.id, 'r1');
  assert.deepEqual(r.clauses, [
    { type: 'price', op: '<', amount: 2500000 },
    { type: 'price', op: '<=', amount: 2450000 },
    { type: 'drop', amount: 250000 },
    { type: 'drop', percent: 10 },
    { type: 'new' },
    { type: 'keyword', text: '256gb', negate: false },
    { type: 'keyword', text: 'icloud', negate: true },
  ]);
});

test('parseRule keeps & inside a quoted keyword and allows decimal percents', () => {
  const r = parseRule('keyword:"256 GB & box" & drop>=12.5%', 'r1');
  assert.deepEqual(r.clauses, [
    { type: 'keyword', text: '256 gb & box', negate: false },
    { type: 'drop', percent: 12.5 },
  ]);
});

test('parseRule accepts commas in amounts', () => {
  assert.deepEqual(parseRule('price<1,200,000', 'r1').clauses, [{ type: 'price', op: '<', amount: 120000000 }]);
});

test('parseRule rejects bad clauses with a message naming the rule', () => {
  for (const bad of ['price<', 'drop>=0%', 'foo', 'new & ', 'price < 5', 'keyword:', 'keyword:"open', 'drop>=101%', 'drop>=0']) {
    assert.throws(() => parseRule(bad, 'r1'), (err) => {
      assert.match(err.message, /^Bad alert rule "/);
      return true;
    }, bad);
  }
  assert.throws(() => parseRule('foo', 'r1'), /unknown clause "foo"/);
});

test('parseRules numbers rules r1, r2, …', () => {
  const rules = parseRules(['new', 'price<5000']);
  assert.deepEqual(rules.map((r) => r.id), ['r1', 'r2']);
});

test('evaluate: price clause uses < and <=, and needs a price', () => {
  const l = listing();
  assert.equal(evaluate(parseRule('price<25001', 'r1'), l).match, true);
  assert.equal(evaluate(parseRule('price<25000', 'r1'), l).match, false);
  assert.equal(evaluate(parseRule('price<=25000', 'r1'), l).match, true);
  assert.equal(evaluate(parseRule('price<=25000', 'r1'), listing({ price: null })).match, false);
  assert.equal(evaluate(parseRule('price<=25000', 'r1'), l).reason, 'price ₱25,000 <= ₱25,000');
});

test('evaluate: drop by amount and by percent, against the first seen price', () => {
  const l = listing(); // first 27,500, now 25,000: down 2,500 = 9.09%
  const amt = evaluate(parseRule('drop>=2500', 'r1'), l);
  assert.equal(amt.match, true);
  assert.equal(amt.reason, 'down ₱2,500 (9%) since first seen');
  assert.equal(evaluate(parseRule('drop>=2501', 'r1'), l).match, false);
  assert.equal(evaluate(parseRule('drop>=9%', 'r1'), l).match, true);
  assert.equal(evaluate(parseRule('drop>=10%', 'r1'), l).match, false);
  assert.equal(evaluate(parseRule('drop>=5%', 'r1'), listing({ priceHistory: [] })).match, false);
});

test('evaluate: new only when isNew is set', () => {
  const r = parseRule('new', 'r1');
  assert.equal(evaluate(r, listing(), { isNew: true }).reason, 'new');
  assert.equal(evaluate(r, listing(), { isNew: false }).match, false);
  assert.equal(cardMatches(r, listing()), true);
});

test('evaluate: keyword matches title, and the description once details are in', () => {
  const l = listing({ title: 'Test Phone 128GB' });
  assert.equal(evaluate(parseRule('keyword:"256 gb"', 'r1'), l).match, false);
  const withDetail = listing({ detail: { description: 'Comes with a 256 GB card', sellerName: null, postedText: null, condition: null, at: 'x' } });
  const hit = evaluate(parseRule('keyword:"256 gb"', 'r1'), withDetail);
  assert.equal(hit.match, true);
  assert.equal(hit.reason, 'has "256 gb"');
  assert.equal(evaluate(parseRule('-keyword:"256 gb"', 'r1'), withDetail).match, false);
  assert.equal(evaluate(parseRule('-keyword:icloud', 'r1'), l).reason, 'no "icloud"');
});

test('evaluate: keyword is accent-insensitive', () => {
  const l = listing({ title: 'Teléfono de prueba' });
  assert.equal(evaluate(parseRule('keyword:telefono', 'r1'), l).match, true);
  assert.equal(evaluate(parseRule('keyword:teléfono', 'r1'), listing({ title: 'telefono' })).match, true);
});

test('evaluate: non-active listings never match', () => {
  for (const status of ['sold', 'pending', 'missing']) {
    assert.deepEqual(evaluate(parseRule('price<99999999', 'r1'), listing({ status })), { match: false, reason: '' });
  }
});

test('evaluate: all clauses must hold and reasons join with "; "', () => {
  const r = evaluate(parseRule('price<30000 & drop>=2500 & keyword:phone', 'r1'), listing());
  assert.equal(r.match, true);
  assert.equal(r.reason, 'price ₱25,000 < ₱30,000; down ₱2,500 (9%) since first seen; has "phone"');
  assert.equal(evaluate(parseRule('price<30000 & keyword:tablet', 'r1'), listing()).match, false);
});

test('formatMoney: PHP, USD with decimals, unknown currency, null', () => {
  assert.equal(formatMoney({ amount: 2450000, currency: 'PHP' }), '₱24,500');
  assert.equal(formatMoney({ amount: 1250, currency: 'USD' }), '$12.50');
  assert.equal(formatMoney({ amount: 300, currency: 'EUR' }), '€3');
  assert.equal(formatMoney({ amount: 100000, currency: 'GBP' }), '£1,000');
  assert.equal(formatMoney({ amount: 100000, currency: 'XYZ' }), 'XYZ 1,000');
  assert.equal(formatMoney({ amount: null, currency: 'PHP' }), '?');
  assert.equal(formatMoney(null), '?');
});

test('fire: fires once and stays quiet while the price is unchanged', () => {
  const rules = parseRules(['price<30000']);
  const known = { '1000000000000001': listing() };
  const ctx = { pass: 2, at: 'T2', watchId: 'w1', newIds: new Set() };
  const first = fire(rules, known, {}, ctx);
  assert.equal(first.alerts.length, 1);
  const a = first.alerts[0];
  assert.equal(a.id, 'w1:2:r1:1000000000000001');
  assert.equal(a.ruleId, 'r1');
  assert.equal(a.ruleText, 'price<30000');
  assert.equal(a.prevPrice.amount, 2750000);
  assert.equal(a.reason, 'price ₱25,000 < ₱30,000');
  const second = fire(rules, known, first.state, { ...ctx, pass: 3 });
  assert.equal(second.alerts.length, 0);
});

test('fire: re-fires on a price change with a "was" reason', () => {
  const rules = parseRules(['price<30000']);
  const ctx = { pass: 2, at: 'T2', watchId: 'w1', newIds: new Set() };
  const s1 = fire(rules, { '1000000000000001': listing() }, {}, ctx).state;
  const changed = listing({ price: { amount: 2400000, currency: 'PHP', raw: '₱24,000' } });
  const out = fire(rules, { '1000000000000001': changed }, s1, { ...ctx, pass: 3 });
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].reason, 'price ₱24,000 < ₱30,000; was ₱25,000');
  assert.deepEqual(out.alerts[0].prevPrice, { amount: 2500000, currency: 'PHP' });
});

test('fire: fires again after the rule turns false then true', () => {
  const rules = parseRules(['price<30000']);
  const ctx = { watchId: 'w1', newIds: new Set() };
  const hit = { '1000000000000001': listing() };
  const miss = { '1000000000000001': listing({ price: { amount: 4000000, currency: 'PHP', raw: '₱40,000' } }) };
  const s1 = fire(rules, hit, {}, { ...ctx, pass: 1, at: 'T1' }).state;
  const s2 = fire(rules, miss, s1, { ...ctx, pass: 2, at: 'T2' });
  assert.equal(s2.alerts.length, 0);
  const s3 = fire(rules, hit, s2.state, { ...ctx, pass: 3, at: 'T3' });
  assert.equal(s3.alerts.length, 1);
  assert.equal(s3.alerts[0].reason, 'price ₱25,000 < ₱30,000');
});

test('fire: new fires only through newIds', () => {
  const rules = parseRules(['new']);
  const known = { '1000000000000001': listing() };
  const ctx = { pass: 2, at: 'T2', watchId: 'w1' };
  assert.equal(fire(rules, known, {}, { ...ctx, newIds: [] }).alerts.length, 0);
  const out = fire(rules, known, {}, { ...ctx, newIds: new Set(['1000000000000001']) });
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].reason, 'new');
  assert.equal(out.alerts[0].prevPrice.amount, 2750000);
});

test('fire: does not mutate its inputs', () => {
  const rules = parseRules(['price<30000', 'new']);
  const known = { '1000000000000001': listing() };
  const state = { 'r1:1000000000000001': { matched: false, lastPrice: null } };
  const before = structuredClone({ rules, known, state });
  fire(rules, known, state, { pass: 2, at: 'T2', watchId: 'w1', newIds: new Set(['1000000000000001']) });
  assert.deepEqual({ rules, known, state }, before);
});
