import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, applyDetail, detailQueue } from '../src/watch/diff.js';

const AT = '2026-11-14T10:00:00.000Z';
const AT2 = '2026-11-14T11:00:00.000Z';
const AT3 = '2026-11-14T12:00:00.000Z';

function card(id, { title = `Test Item ${id}`, amount = 100000, label = null, location = 'Test City' } = {}) {
  return {
    id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title,
    price: amount === null ? null : { amount, currency: 'PHP', raw: '₱1' },
    location,
    image: null,
    label,
  };
}

function ctx(pass, extra = {}) {
  return { pass, at: pass === 1 ? AT : pass === 2 ? AT2 : AT3, maxListings: 40, cardsRead: 3, ...extra };
}

test('pass 1 emits no new events, pass 2 emits new for an unseen id', () => {
  const p1 = diff({}, [card('1000000000000001')], ctx(1));
  assert.deepEqual(p1.events, []);
  assert.equal(p1.known['1000000000000001'].status, 'active');
  assert.deepEqual(p1.known['1000000000000001'].priceHistory, [{ pass: 1, at: AT, amount: 100000 }]);

  const p2 = diff(p1.known, [card('1000000000000001'), card('1000000000000002')], ctx(2));
  assert.deepEqual(p2.events, [
    { at: AT2, pass: 2, type: 'new', listingId: '1000000000000002', from: null, to: null },
  ]);
});

test('price drop and rise emit events and push history', () => {
  const p1 = diff({}, [card('1000000000000001', { amount: 100000 })], ctx(1));
  const drop = diff(p1.known, [card('1000000000000001', { amount: 90000 })], ctx(2));
  assert.deepEqual(drop.events, [
    { at: AT2, pass: 2, type: 'price_drop', listingId: '1000000000000001', from: 100000, to: 90000 },
  ]);
  assert.equal(drop.known['1000000000000001'].price.amount, 90000);
  assert.equal(drop.known['1000000000000001'].priceHistory.length, 2);

  const up = diff(drop.known, [card('1000000000000001', { amount: 95000 })], ctx(3));
  assert.deepEqual(up.events, [
    { at: AT3, pass: 3, type: 'price_up', listingId: '1000000000000001', from: 90000, to: 95000 },
  ]);
});

test('a price going from null to a value sets it with no event', () => {
  const p1 = diff({}, [card('1000000000000001', { amount: null })], ctx(1));
  assert.deepEqual(p1.known['1000000000000001'].priceHistory, []);
  const p2 = diff(p1.known, [card('1000000000000001', { amount: 50000 })], ctx(2));
  assert.deepEqual(p2.events, []);
  assert.equal(p2.known['1000000000000001'].price.amount, 50000);
  assert.deepEqual(p2.known['1000000000000001'].priceHistory, [{ pass: 2, at: AT2, amount: 50000 }]);
});

test('title change emits an event', () => {
  const p1 = diff({}, [card('1000000000000001', { title: 'Test Phone' })], ctx(1));
  const p2 = diff(p1.known, [card('1000000000000001', { title: 'Test Phone 256GB' })], ctx(2));
  assert.deepEqual(p2.events, [
    { at: AT2, pass: 2, type: 'title_change', listingId: '1000000000000001', from: 'Test Phone', to: 'Test Phone 256GB' },
  ]);
  assert.equal(p2.known['1000000000000001'].title, 'Test Phone 256GB');
});

test('sold, pending and back from sold', () => {
  const p1 = diff({}, [card('1000000000000001')], ctx(1));
  const sold = diff(p1.known, [card('1000000000000001', { label: 'sold' })], ctx(2));
  assert.deepEqual(sold.events, [
    { at: AT2, pass: 2, type: 'sold', listingId: '1000000000000001', from: 'active', to: 'sold' },
  ]);
  assert.equal(sold.known['1000000000000001'].status, 'sold');

  const pending = diff(p1.known, [card('1000000000000001', { label: 'pending' })], ctx(2));
  assert.equal(pending.events[0].type, 'pending');
  assert.equal(pending.known['1000000000000001'].status, 'pending');

  const back = diff(sold.known, [card('1000000000000001')], ctx(3));
  assert.deepEqual(back.events, [
    { at: AT3, pass: 3, type: 'back', listingId: '1000000000000001', from: 'sold', to: 'active' },
  ]);
  assert.equal(back.known['1000000000000001'].status, 'active');
});

test('a new listing that is already sold emits new but no sold event', () => {
  const r = diff({}, [card('1000000000000010', { label: 'sold' })], ctx(2));
  assert.deepEqual(r.events.map((e) => e.type), ['new']);
  assert.equal(r.known['1000000000000010'].status, 'sold');
});

test('missing after two misses on a full page, not before', () => {
  // Full page: 40 cards read, listing ranked at 0 (top 75%), so misses count.
  const full = { maxListings: 40, cardsRead: 40 };
  const p1 = diff({}, [card('1000000000000001')], ctx(1, full));
  const m1 = diff(p1.known, [], ctx(2, full));
  assert.deepEqual(m1.events, []);
  assert.equal(m1.known['1000000000000001'].missedPasses, 1);
  assert.equal(m1.known['1000000000000001'].status, 'active');

  const m2 = diff(m1.known, [], ctx(3, full));
  assert.deepEqual(m2.events, [
    { at: AT3, pass: 3, type: 'missing', listingId: '1000000000000001', from: 'active', to: 'missing' },
  ]);
  assert.equal(m2.known['1000000000000001'].status, 'missing');

  const back = diff(m2.known, [card('1000000000000001')], ctx(3, full));
  assert.equal(back.events[0].type, 'back');
  assert.equal(back.known['1000000000000001'].status, 'active');
  assert.equal(back.known['1000000000000001'].missedPasses, 0);
});

test('a listing ranked in the top 75% of a full page is not counted when results run out', () => {
  // Full page (40 read of 40). The listing at rank 35 is outside the top 75% (needs lastRank < 30),
  // so its absence must not count as a miss.
  const full = { maxListings: 40, cardsRead: 40 };
  const seenList = Array.from({ length: 36 }, (_, i) => card(`10000000000000${String(i).padStart(2, '0')}`));
  const p1 = diff({}, seenList, ctx(1, full));
  const lowRank = seenList[35].id;
  const later = seenList.filter((c) => c.id !== lowRank).slice(0, 35);
  const m1 = diff(p1.known, later, ctx(2, full));
  assert.equal(m1.known[lowRank].missedPasses, 0);
  assert.equal(m1.known[lowRank].status, 'active');
});

test('results running out counts a miss even for a low-ranked listing', () => {
  const short = { maxListings: 40, cardsRead: 5 };
  const seenList = Array.from({ length: 6 }, (_, i) => card(`10000000000000${String(i).padStart(2, '0')}`));
  const p1 = diff({}, seenList, ctx(1, short));
  const lowRank = seenList[5].id;
  const m1 = diff(p1.known, seenList.slice(0, 5), ctx(2, { maxListings: 40, cardsRead: 5 }));
  assert.equal(m1.known[lowRank].missedPasses, 1);
});

test('duplicate ids in seen keep the first occurrence', () => {
  const r = diff({}, [card('1000000000000001', { title: 'First' }), card('1000000000000001', { title: 'Second' })], ctx(1));
  assert.equal(Object.keys(r.known).length, 1);
  assert.equal(r.known['1000000000000001'].title, 'First');
  assert.equal(r.known['1000000000000001'].lastRank, 0);
});

test('diff does not mutate its inputs', () => {
  const p1 = diff({}, [card('1000000000000001', { amount: 100000 }), card('1000000000000002')], ctx(1));
  const known = structuredClone(p1.known);
  const seen = [card('1000000000000001', { amount: 90000, title: 'Renamed' }), card('1000000000000003', { label: 'sold' })];
  const seenBefore = structuredClone(seen);
  const knownBefore = structuredClone(known);
  diff(known, seen, ctx(2));
  assert.deepEqual(known, knownBefore);
  assert.deepEqual(seen, seenBefore);
});

test('applyDetail fills detail, emits a price change, and a null label does not emit back', () => {
  const p1 = diff({}, [card('1000000000000001', { amount: 100000, label: 'sold' })], ctx(1));
  const p2 = diff(p1.known, [card('1000000000000001', { amount: 100000 })], ctx(2)); // back
  assert.equal(p2.known['1000000000000001'].status, 'active');

  const withDetail = applyDetail(p2.known, '1000000000000001', {
    title: null,
    price: { amount: 80000, currency: 'PHP', raw: '₱800' },
    label: null,
    description: 'Test description',
    sellerName: 'Juan Test',
    postedText: '2 days ago',
    condition: 'Used',
  }, ctx(2));
  assert.deepEqual(withDetail.events, [
    { at: AT2, pass: 2, type: 'price_drop', listingId: '1000000000000001', from: 100000, to: 80000 },
  ]);
  const entry = withDetail.known['1000000000000001'];
  assert.deepEqual(entry.detail, {
    description: 'Test description',
    sellerName: 'Juan Test',
    postedText: '2 days ago',
    condition: 'Used',
    at: AT2,
  });

  const reactivate = applyDetail(
    { ...p2.known, '1000000000000001': { ...entry, status: 'sold' } },
    '1000000000000001',
    { title: null, price: null, label: null },
    ctx(2),
  );
  assert.deepEqual(reactivate.events, []);
  assert.equal(reactivate.known['1000000000000001'].status, 'sold');
});

test('applyDetail with an unknown id returns the inputs unchanged', () => {
  const known = {};
  const r = applyDetail(known, '1000000000000099', { label: null }, ctx(2));
  assert.equal(r.known, known);
  assert.deepEqual(r.events, []);
});

test('detailQueue orders by priority, price ascending with null last, then first seen, then id', () => {
  let known = diff({}, [
    card('1000000000000001', { amount: 300000 }),
    card('1000000000000002', { amount: null }),
    card('1000000000000003', { amount: 100000 }),
    card('1000000000000004', { amount: 100000 }),
  ], ctx(1)).known;
  known = diff(known, [
    card('1000000000000005', { amount: 50000 }),
    card('1000000000000006', { amount: 100000 }),
  ], ctx(2)).known;

  // 5 is cheapest; 3 and 4 tie at 100000 but were seen in pass 1, so before 6 (pass 2).
  assert.deepEqual(detailQueue(known), [
    '1000000000000005',
    '1000000000000003',
    '1000000000000004',
    '1000000000000006',
    '1000000000000001',
    '1000000000000002',
  ]);

  const priority = detailQueue(known, { isPriority: (l) => l.id === '1000000000000001' });
  assert.equal(priority[0], '1000000000000001');
  assert.equal(priority.length, 6);
});

test('detailQueue excludes sold, missing and already detailed listings', () => {
  let known = diff({}, [
    card('1000000000000001', { amount: 1 }),
    card('1000000000000002', { amount: 2, label: 'sold' }),
    card('1000000000000003', { amount: 3 }),
    card('1000000000000004', { amount: 4 }),
  ], ctx(1)).known;
  known = applyDetail(known, '1000000000000003', { label: null, price: null, title: null }, ctx(2)).known;
  known = { ...known, '1000000000000004': { ...known['1000000000000004'], status: 'missing' } };
  assert.deepEqual(detailQueue(known), ['1000000000000001']);
});
