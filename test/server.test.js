import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { WatchStore } from '../src/watch/store.js';

// All data here is made up. Nothing reads .env or config.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const WATCH_ID = '20261114-090507-test-phone-128gb';
const OTHER_ID = '20261113-080000-test-laptop';

function seed(store) {
  store.create({
    id: WATCH_ID,
    query: 'Test Phone 128GB',
    status: 'running',
    passesDone: 2,
    passesTotal: 4,
    until: null,
    nextPassAt: '2026-11-14T02:00:00.000Z',
    filters: { minPrice: null, maxPrice: 30000, location: null, radiusKm: 6, daysSinceListed: null },
    searchArea: 'Test City, 6 km',
    lastError: null,
    detailsQueued: 3,
    alerts: [{ id: 'r1', text: 'price<25000', clauses: [] }],
  });
  store.writeListings(WATCH_ID, {
    '1000000000000001': {
      id: '1000000000000001',
      url: 'https://www.facebook.com/marketplace/item/1000000000000001/',
      title: 'Test Phone 128GB',
      image: null,
      location: 'Test City',
      price: { amount: 2200000, currency: 'PHP', raw: '₱22,000' },
      priceHistory: [
        { pass: 1, at: '2026-11-14T01:00:00.000Z', amount: 2500000 },
        { pass: 2, at: '2026-11-14T01:30:00.000Z', amount: 2200000 },
      ],
      firstSeen: { pass: 1, at: '2026-11-14T01:00:00.000Z' },
      lastSeen: { pass: 2, at: '2026-11-14T01:30:00.000Z' },
      lastRank: 0,
      missedPasses: 0,
      status: 'active',
      detail: null,
    },
    '1000000000000002': {
      id: '1000000000000002',
      url: 'https://www.facebook.com/marketplace/item/1000000000000002/',
      title: 'Test Phone Sold One',
      image: null,
      location: null,
      price: { amount: 1800000, currency: 'PHP', raw: '₱18,000' },
      priceHistory: [{ pass: 1, at: '2026-11-14T01:00:00.000Z', amount: 1800000 }],
      firstSeen: { pass: 1, at: '2026-11-14T01:00:00.000Z' },
      lastSeen: { pass: 2, at: '2026-11-14T01:30:00.000Z' },
      lastRank: 1,
      missedPasses: 0,
      status: 'sold',
      detail: null,
    },
  });
  store.appendPass(WATCH_ID, {
    n: 1, startedAt: '2026-11-14T01:00:00.000Z', endedAt: '2026-11-14T01:01:00.000Z', ok: true,
    error: null, seenIds: ['1000000000000001'], cardsRead: 2, detailsOpened: 0, visits: 1, searchArea: 'Test City, 6 km',
  });
  store.appendPass(WATCH_ID, {
    n: 2, startedAt: '2026-11-14T01:30:00.000Z', endedAt: '2026-11-14T01:31:00.000Z', ok: false,
    error: 'Test failure', seenIds: [], cardsRead: 0, detailsOpened: 0, visits: 1, searchArea: null,
  });
  store.appendEvents(WATCH_ID, [
    { at: '2026-11-14T01:00:00.000Z', pass: 1, type: 'new', listingId: '1000000000000001', from: null, to: null },
    { at: '2026-11-14T01:00:01.000Z', pass: 1, type: 'new', listingId: '1000000000000002', from: null, to: null },
    { at: '2026-11-14T01:30:00.000Z', pass: 2, type: 'price_drop', listingId: '1000000000000001', from: 2500000, to: 2200000 },
    { at: '2026-11-14T01:30:05.000Z', pass: 2, type: 'sold', listingId: '1000000000000002', from: 'active', to: 'sold' },
  ]);
  store.appendAlerts(WATCH_ID, [
    {
      id: `${WATCH_ID}:2:r1:1000000000000001`, at: '2026-11-14T01:30:00.000Z', pass: 2, watchId: WATCH_ID,
      ruleId: 'r1', ruleText: 'price<25000', listingId: '1000000000000001', title: 'Test Phone 128GB',
      url: 'https://www.facebook.com/marketplace/item/1000000000000001/', location: 'Test City',
      price: { amount: 2200000, currency: 'PHP', raw: '₱22,000' }, prevPrice: { amount: 2500000, currency: 'PHP' },
      reason: 'price ₱22,000 < ₱25,000; was ₱25,000',
    },
    {
      id: `${WATCH_ID}:1:r1:1000000000000002`, at: '2026-11-14T01:00:00.000Z', pass: 1, watchId: WATCH_ID,
      ruleId: 'r1', ruleText: 'price<25000', listingId: '1000000000000002', title: 'Test Phone Sold One',
      url: 'https://www.facebook.com/marketplace/item/1000000000000002/', location: null,
      price: { amount: 1800000, currency: 'PHP', raw: '₱18,000' }, prevPrice: null,
      reason: 'price ₱18,000 < ₱25,000',
    },
  ]);
  store.create({
    id: OTHER_ID, query: 'Test Laptop', status: 'done', passesDone: 1, passesTotal: 1,
    until: null, nextPassAt: null, filters: {}, searchArea: null, lastError: null, detailsQueued: 0, alerts: [],
  });
  store.appendEvents(OTHER_ID, [
    { at: '2026-11-13T00:00:00.000Z', pass: 1, type: 'new', listingId: '2000000000000001', from: null, to: null },
  ]);
  store.appendAlerts(OTHER_ID, [
    {
      id: `${OTHER_ID}:1:r1:2000000000000001`, at: '2026-11-13T00:00:00.000Z', pass: 1, watchId: OTHER_ID,
      ruleId: 'r1', ruleText: 'new', listingId: '2000000000000001', title: 'Test Laptop', url: null,
      location: null, price: null, prevPrice: null, reason: 'new',
    },
  ]);
}

/**
 * Raw HTTP request, so the Host header can be set (fetch can't).
 * @returns {Promise<{status: number, headers: object, body: string, json: () => any}>}
 */
function request(port, method, urlPath, { host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: { host, ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('server', () => {
  let tmp;
  let store;
  let server;
  let port;
  const jsonType = { 'Content-Type': 'application/json' };
  const origin = () => `http://127.0.0.1:${port}`;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    store = new WatchStore(tmp);
    seed(store);
    server = createServer({ store, publicDir: PUBLIC_DIR });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('GET /api/watches gives summaries and counts', async () => {
    const res = await request(port, 'GET', '/api/watches');
    assert.equal(res.status, 200);
    const list = res.json();
    assert.deepEqual(list.map((w) => w.id), [WATCH_ID, OTHER_ID]); // newest first
    const w = list[0];
    assert.equal(w.query, 'Test Phone 128GB');
    assert.equal(w.passesDone, 2);
    assert.equal(w.searchArea, 'Test City, 6 km');
    assert.deepEqual(w.counts, { total: 2, active: 1, sold: 1, pending: 0, missing: 0, new: 2, priceDrops: 1 });
    assert.equal(w.unreadAlerts, 2);
  });

  test('GET /api/watches/:id gives watch, listings in order, passes and detailsQueued', async () => {
    const res = await request(port, 'GET', `/api/watches/${WATCH_ID}`);
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.watch.id, WATCH_ID);
    assert.deepEqual(body.listings.map((l) => l.id), ['1000000000000001', '1000000000000002']);
    assert.equal(body.passes.length, 2);
    assert.equal(body.detailsQueued, 3);
  });

  test('GET /api/watches/:id is 404 for unknown and invalid ids', async () => {
    assert.equal((await request(port, 'GET', '/api/watches/20001231-000000-nope')).status, 404);
    assert.equal((await request(port, 'GET', '/api/watches/..%2Fx')).status, 404);
    assert.equal((await request(port, 'GET', '/api/watches/..%2F..%2Fetc')).status, 404);
  });

  test('events honour since, limit and newest-first order', async () => {
    const all = (await request(port, 'GET', `/api/watches/${WATCH_ID}/events`)).json();
    assert.equal(all.length, 4);
    assert.equal(all[0].type, 'sold'); // newest first

    const since = (await request(port, 'GET', `/api/watches/${WATCH_ID}/events?since=2026-11-14T01:00:00.500Z`)).json();
    assert.deepEqual(since.map((e) => e.type), ['sold', 'price_drop', 'new']);

    const limited = (await request(port, 'GET', `/api/watches/${WATCH_ID}/events?limit=1`)).json();
    assert.equal(limited.length, 1);

    assert.equal((await request(port, 'GET', `/api/watches/${WATCH_ID}/events?limit=0`)).status, 400);
    assert.equal((await request(port, 'GET', `/api/watches/${WATCH_ID}/events?since=nonsense`)).status, 400);
  });

  test('alerts list newest first, with unread and watch filters and a read flag', async () => {
    const all = (await request(port, 'GET', '/api/alerts')).json();
    assert.deepEqual(all.map((a) => a.watchId), [WATCH_ID, WATCH_ID, OTHER_ID]);
    assert.ok(all.every((a) => a.read === false));

    const forWatch = (await request(port, 'GET', `/api/alerts?watch=${OTHER_ID}`)).json();
    assert.equal(forWatch.length, 1);

    const unread = (await request(port, 'GET', '/api/alerts?unread=1')).json();
    assert.equal(unread.length, 3);

    assert.equal((await request(port, 'GET', '/api/alerts?watch=../x')).status, 404);
  });

  test('POST /api/alerts/read marks by ids and by all, and the unread filter follows', async () => {
    const first = (await request(port, 'GET', '/api/alerts')).json()[0];
    const byId = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: origin() },
      body: { watch: WATCH_ID, ids: [first.id] },
    });
    assert.equal(byId.status, 200);
    assert.deepEqual(byId.json(), { ok: true, marked: 1 });
    assert.equal((await request(port, 'GET', '/api/alerts?unread=1')).json().length, 2);

    const again = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: origin() },
      body: { watch: WATCH_ID, ids: [first.id] },
    });
    assert.deepEqual(again.json(), { ok: true, marked: 0 });

    const all = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: origin() },
      body: { watch: WATCH_ID, all: true },
    });
    assert.deepEqual(all.json(), { ok: true, marked: 1 });
    const unreadNow = (await request(port, 'GET', '/api/alerts?unread=1')).json();
    assert.deepEqual(unreadNow.map((a) => a.watchId), [OTHER_ID]);
  });

  test('POST /api/alerts/read ignores ids that are not alerts of that watch', async () => {
    const res = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: origin() },
      body: { watch: WATCH_ID, ids: ['made-up-id'] },
    });
    assert.deepEqual(res.json(), { ok: true, marked: 0 });
    assert.equal(store.readReadIds(WATCH_ID).has('made-up-id'), false);
  });

  test('POST /api/alerts/read rejects an unknown watch, bad ids and bad JSON', async () => {
    const headers = { ...jsonType, Origin: origin() };
    assert.equal((await request(port, 'POST', '/api/alerts/read', { headers, body: { watch: '../x', all: true } })).status, 404);
    assert.equal((await request(port, 'POST', '/api/alerts/read', { headers, body: { watch: OTHER_ID, ids: 'x' } })).status, 400);
    assert.equal((await request(port, 'POST', '/api/alerts/read', { headers, body: '{not json' })).status, 400);
  });

  test('POST /api/alerts/read rejects bodies over 10 KB', async () => {
    const big = { watch: OTHER_ID, ids: ['x'.repeat(11 * 1024)] };
    const res = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: origin() },
      body: big,
    });
    assert.equal(res.status, 400);
    assert.match(res.json().error, /too large/);
  });

  test('403 for a bad Host header', async () => {
    const res = await request(port, 'GET', '/api/watches', { host: 'evil.example' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json(), { error: 'Bad host' });
    assert.equal((await request(port, 'GET', '/', { host: `192.168.1.5:${port}` })).status, 403);
  });

  test('localhost Host is accepted', async () => {
    const res = await request(port, 'GET', '/api/watches', { host: `localhost:${port}` });
    assert.equal(res.status, 200);
  });

  test('403 for a missing or foreign Origin on POST', async () => {
    const body = { watch: OTHER_ID, all: true };
    assert.equal((await request(port, 'POST', '/api/alerts/read', { headers: jsonType, body })).status, 403);
    const foreign = await request(port, 'POST', '/api/alerts/read', {
      headers: { ...jsonType, Origin: 'https://evil.example' },
      body,
    });
    assert.equal(foreign.status, 403);
  });

  test('403 for a wrong content type on POST', async () => {
    const res = await request(port, 'POST', '/api/alerts/read', {
      headers: { 'Content-Type': 'text/plain', Origin: origin() },
      body: { watch: OTHER_ID, all: true },
    });
    assert.equal(res.status, 403);
  });

  test('405 for a wrong method on an API route', async () => {
    const res = await request(port, 'POST', '/api/watches', { headers: { ...jsonType, Origin: origin() }, body: {} });
    assert.equal(res.status, 405);
    assert.deepEqual(res.json(), { error: 'Method not allowed' });
    assert.equal((await request(port, 'GET', '/api/alerts/read')).status, 405);
    assert.equal((await request(port, 'DELETE', `/api/watches/${WATCH_ID}`)).status, 405);
  });

  test('404 for unknown API paths and bad static names', async () => {
    assert.equal((await request(port, 'GET', '/api/nope')).status, 404);
    assert.equal((await request(port, 'GET', '/static/..%2Fserver.js')).status, 404);
    assert.equal((await request(port, 'GET', '/static/app.html')).status, 404);
    assert.equal((await request(port, 'GET', '/static/missing.js')).status, 404);
    assert.equal((await request(port, 'GET', '/static/a%2Fb.js')).status, 404);
  });

  test('index and a static file are served with the CSP and nosniff headers', async () => {
    const index = await request(port, 'GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.match(index.body, /<script type="module" src="\/static\/app\.js">/);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    assert.match(index.headers['content-security-policy'], /img-src 'self' https:\/\/\*\.fbcdn\.net data:/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');

    const js = await request(port, 'GET', '/static/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^application\/javascript/);
    assert.ok(js.headers['content-security-policy']);

    const css = await request(port, 'GET', '/static/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
  });

  test('JSON errors carry the security headers too', async () => {
    const res = await request(port, 'GET', '/api/nope');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['content-security-policy']);
  });
});
