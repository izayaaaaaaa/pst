import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemIdFromHref, parsePrice, parseCard, parseDetail } from '../src/market/parse.js';

test('itemIdFromHref handles absolute, relative and query-string hrefs', () => {
  assert.equal(itemIdFromHref('https://www.facebook.com/marketplace/item/1000000000000001/'), '1000000000000001');
  assert.equal(itemIdFromHref('/marketplace/item/1000000000000002/'), '1000000000000002');
  assert.equal(itemIdFromHref('/marketplace/item/1000000000000003/?ref=search'), '1000000000000003');
  assert.equal(itemIdFromHref('https://www.facebook.com/groups/123'), null);
  assert.equal(itemIdFromHref(undefined), null);
});

test('parsePrice reads symbols, codes, commas, decimals and Free', () => {
  assert.deepEqual(parsePrice('₱1,200'), { amount: 120000, currency: 'PHP', raw: '₱1,200' });
  assert.deepEqual(parsePrice('PHP 1,200'), { amount: 120000, currency: 'PHP', raw: 'PHP 1,200' });
  assert.deepEqual(parsePrice('PHP1200'), { amount: 120000, currency: 'PHP', raw: 'PHP1200' });
  assert.deepEqual(parsePrice('$50.50'), { amount: 5050, currency: 'USD', raw: '$50.50' });
  assert.deepEqual(parsePrice('₱1,200.50'), { amount: 120050, currency: 'PHP', raw: '₱1,200.50' });
  assert.deepEqual(parsePrice('€3'), { amount: 300, currency: 'EUR', raw: '€3' });
  assert.deepEqual(parsePrice('£1,000'), { amount: 100000, currency: 'GBP', raw: '£1,000' });
  assert.deepEqual(parsePrice('Free'), { amount: 0, currency: 'PHP', raw: 'Free' });
  assert.deepEqual(parsePrice('free', 'USD'), { amount: 0, currency: 'USD', raw: 'Free' });
});

test('parsePrice returns null for a bare number, empty input and non-strings', () => {
  assert.equal(parsePrice('1200'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
});

test('parsePrice takes the first of two prices', () => {
  assert.deepEqual(parsePrice('₱2,500 ₱3,000'), { amount: 250000, currency: 'PHP', raw: '₱2,500' });
});

test('parseCard reads a normal 3-line card', () => {
  const card = parseCard({
    href: '/marketplace/item/1000000000000001/',
    text: 'Test Phone 128GB\n₱25,000\nJuan Test City',
    img: 'https://scontent.example.test/a.jpg',
  });
  assert.deepEqual(card, {
    id: '1000000000000001',
    url: 'https://www.facebook.com/marketplace/item/1000000000000001/',
    title: 'Test Phone 128GB',
    price: { amount: 2500000, currency: 'PHP', raw: '₱25,000' },
    location: 'Juan Test City',
    image: 'https://scontent.example.test/a.jpg',
    label: null,
  });
});

test('parseCard keeps only the first price of a discounted card', () => {
  const card = parseCard({
    href: '/marketplace/item/1000000000000002/',
    text: 'Test Desk Lamp\n₱800\n₱1,200\nTest Town',
    img: null,
  });
  assert.equal(card.title, 'Test Desk Lamp');
  assert.equal(card.price.amount, 80000);
  assert.equal(card.location, 'Test Town');
  assert.equal(card.image, null);
});

test('parseCard reads Sold and Pending labels and skips the label line', () => {
  const sold = parseCard({ href: '/marketplace/item/1000000000000003/', text: 'Test Bike\nSold\n₱4,000\nTest City' });
  assert.equal(sold.label, 'sold');
  assert.equal(sold.title, 'Test Bike');
  assert.equal(sold.price.amount, 400000);

  const pending = parseCard({ href: '/marketplace/item/1000000000000004/', text: 'pending\nTest Chair\n₱300' });
  assert.equal(pending.label, 'pending');
  assert.equal(pending.title, 'Test Chair');
  assert.equal(pending.location, null);
});

test('parseCard returns null for a Sponsored card', () => {
  assert.equal(
    parseCard({ href: '/marketplace/item/1000000000000005/', text: 'Sponsored\nTest Ad\n₱100' }),
    null,
  );
  assert.equal(
    parseCard({ href: '/marketplace/item/1000000000000005/', text: 'sponsored\nTest Ad\n₱100' }),
    null,
  );
});

test('parseCard with no location gives location null', () => {
  const card = parseCard({ href: '/marketplace/item/1000000000000006/', text: 'Test Fan\n₱500' });
  assert.equal(card.title, 'Test Fan');
  assert.equal(card.location, null);
});

test('parseCard returns null when there is no item id', () => {
  assert.equal(parseCard({ href: '/groups/123', text: 'Test Thing\n₱100' }), null);
  assert.equal(parseCard({ href: null, text: 'Test Thing\n₱100' }), null);
});

test('parseCard returns null when no line is a title', () => {
  assert.equal(parseCard({ href: '/marketplace/item/1000000000000007/', text: '₱100\nSold' }), null);
});

test('parseDetail trims, nulls empties and parses price and label', () => {
  const detail = parseDetail({
    title: '  Test Phone 128GB  ',
    priceText: '₱24,500',
    labelText: 'Sold',
    description: '   ',
    sellerName: 'Juan Test',
    postedText: '',
    condition: null,
  });
  assert.deepEqual(detail, {
    title: 'Test Phone 128GB',
    price: { amount: 2450000, currency: 'PHP', raw: '₱24,500' },
    label: 'sold',
    description: null,
    sellerName: 'Juan Test',
    postedText: null,
    condition: null,
  });
});

test('parseDetail label is pending when the text says so, and null otherwise', () => {
  assert.equal(parseDetail({ labelText: 'Pending sale' }).label, 'pending');
  assert.equal(parseDetail({ labelText: 'Listed 2 days ago' }).label, null);
  assert.equal(parseDetail({}).price, null);
});
