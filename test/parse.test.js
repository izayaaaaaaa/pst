import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemIdFromHref, parsePrice, parseCard, parseDetail, detailFieldsFromText } from '../src/market/parse.js';

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

test('parseCard skips the "Just listed" badge and keeps the real title and place', () => {
  const card = parseCard({
    href: '/marketplace/item/1000000000000008/',
    text: 'Just listed\nPHP3,000\nMonitor 24" - test panel\nPasig, NCR',
  });
  assert.equal(card.title, 'Monitor 24" - test panel');
  assert.equal(card.location, 'Pasig, NCR');
  assert.equal(card.price.amount, 300000);
  assert.equal(card.label, null);
});

test('detailFieldsFromText reads an item page by labels and line order', () => {
  // Cleaned from a live page on 2026-11-14: real layout, made-up seller and item text.
  const fields = detailFieldsFromText({
    title: 'Monitor 24" - test panel',
    text: [
      '',
      'Marketplace',
      'Location',
      'Pasig',
      ' · Within 5 km',
      'Monitor 24" - test panel',
      'PHP3,000',
      'Listed about an hour ago in Pasig, NCR',
      'Message',
      'Details',
      'Condition',
      'Used - like new',
      'Open box. Complete accessories',
      '2 pcs available, good as new',
      'Pasig, NCR · Location is approximate',
      'Ads',
      'Seller information',
      'Seller details',
      'Maria Test',
      '(16)',
      'Joined Facebook in 2010',
      'Send seller a message',
      'Send',
      "Today's picks",
      'PHP1,850',
      'Other listing',
      'Pasig, NCR',
    ].join('\n'),
  });
  assert.deepEqual(fields, {
    title: 'Monitor 24" - test panel',
    priceText: 'PHP3,000',
    labelText: null,
    description: 'Open box. Complete accessories\n2 pcs available, good as new',
    sellerName: 'Maria Test',
    postedText: 'Listed about an hour ago in Pasig, NCR',
    condition: 'Used - like new',
  });
});

test('detailFieldsFromText gives a null description when the item has none', () => {
  const fields = detailFieldsFromText({
    title: 'Test Lamp',
    text: [
      'Test Lamp',
      '₱500',
      'Listed 2 days ago in Test City',
      'Details',
      'Condition',
      'Good',
      'Test City, NCR · Location is approximate',
    ].join('\n'),
  });
  assert.equal(fields.description, null);
  assert.equal(fields.condition, 'Good');
  assert.equal(fields.postedText, 'Listed 2 days ago in Test City');
  assert.equal(fields.priceText, '₱500');
});
