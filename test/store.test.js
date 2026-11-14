import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchStore, createWatchId, isValidWatchId } from '../src/watch/store.js';

// All data here is made up.
const NOW = new Date(2026, 10, 14, 9, 5, 7); // local time

function watchFixture(id, extra = {}) {
  return {
    id,
    query: 'Test Phone 128GB',
    status: 'running',
    passesDone: 0,
    passesTotal: 3,
    createdAt: '2026-11-14T01:05:07.000Z',
    ...extra,
  };
}

describe('createWatchId and isValidWatchId', () => {
  test('builds a local-time id with a slug', () => {
    assert.equal(createWatchId('Test Phone 128GB', NOW), '20261114-090507-test-phone-128gb');
  });

  test('strips accents', () => {
    assert.equal(createWatchId('Ñandú Teléfono', NOW), '20261114-090507-nandu-telefono');
  });

  test('symbols only, and empty query, give the slug "watch"', () => {
    assert.equal(createWatchId('!!! ???', NOW), '20261114-090507-watch');
    assert.equal(createWatchId('', NOW), '20261114-090507-watch');
  });

  test('slug is at most 40 characters and never ends in a hyphen', () => {
    const id = createWatchId(`${'x'.repeat(39)} y`, NOW);
    const slug = id.slice('20261114-090507-'.length);
    assert.ok(slug.length <= 40);
    assert.equal(slug, 'x'.repeat(39));
    assert.ok(isValidWatchId(createWatchId('a'.repeat(200), NOW)));
  });

  test('isValidWatchId accepts good ids and rejects bad ones', () => {
    assert.ok(isValidWatchId('20261114-090507-test-phone'));
    assert.ok(!isValidWatchId('../x'));
    assert.ok(!isValidWatchId('20261114-090507-Upper'));
    assert.ok(!isValidWatchId(`20261114-090507-${'a'.repeat(41)}`));
    assert.ok(!isValidWatchId('20261114-090507-'));
    assert.ok(!isValidWatchId(null));
  });
});

describe('WatchStore', () => {
  let dir;
  let store;
  const ID = '20261114-090507-test-phone';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    store = new WatchStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('watch round trip; missing watch reads as null', () => {
    assert.equal(store.readWatch(ID), null);
    store.create(watchFixture(ID));
    assert.deepEqual(store.readWatch(ID), watchFixture(ID));
    store.writeWatch(watchFixture(ID, { passesDone: 2 }));
    assert.equal(store.readWatch(ID).passesDone, 2);
  });

  test('create throws if the watch folder already exists', () => {
    store.create(watchFixture(ID));
    assert.throws(() => store.create(watchFixture(ID)), /already exists/);
  });

  test('listings round trip; missing reads as {}', () => {
    assert.deepEqual(store.readListings(ID), {});
    const known = { '1000000000000001': { id: '1000000000000001', title: 'Test Phone 128GB' } };
    store.writeListings(ID, known);
    assert.deepEqual(store.readListings(ID), known);
  });

  test('alert state round trip; missing reads as {}', () => {
    assert.deepEqual(store.readAlertState(ID), {});
    const state = { 'r1:1000000000000001': { matched: true, lastPrice: 2500000 } };
    store.writeAlertState(ID, state);
    assert.deepEqual(store.readAlertState(ID), state);
  });

  test('passes, events and alerts append and read back in order', () => {
    assert.deepEqual(store.readPasses(ID), []);
    assert.deepEqual(store.readEvents(ID), []);
    assert.deepEqual(store.readAlerts(ID), []);

    store.appendPass(ID, { n: 1, ok: true });
    store.appendPass(ID, { n: 2, ok: false, error: 'Test error' });
    store.appendEvents(ID, [{ type: 'new', listingId: 'a' }]);
    store.appendEvents(ID, [{ type: 'price_drop', listingId: 'a' }, { type: 'sold', listingId: 'b' }]);
    store.appendAlerts(ID, [{ id: 'x1' }]);
    store.appendAlerts(ID, []);

    assert.deepEqual(store.readPasses(ID), [{ n: 1, ok: true }, { n: 2, ok: false, error: 'Test error' }]);
    assert.deepEqual(
      store.readEvents(ID).map((e) => e.type),
      ['new', 'price_drop', 'sold'],
    );
    assert.deepEqual(store.readAlerts(ID), [{ id: 'x1' }]);
  });

  test('a partial last JSONL line is skipped', () => {
    store.appendEvents(ID, [{ type: 'new' }]);
    fs.appendFileSync(path.join(dir, 'watches', ID, 'events.jsonl'), '\n{"type":"pri');
    assert.deepEqual(store.readEvents(ID), [{ type: 'new' }]);
  });

  test('markRead unions ids and returns the number newly marked', () => {
    assert.deepEqual([...store.readReadIds(ID)], []);
    assert.equal(store.markRead(ID, ['a1', 'a2']), 2);
    assert.equal(store.markRead(ID, ['a2', 'a3']), 1);
    assert.equal(store.markRead(ID, ['a1']), 0);
    assert.deepEqual([...store.readReadIds(ID)].sort(), ['a1', 'a2', 'a3']);
  });

  test('writes leave no temp files behind', () => {
    store.create(watchFixture(ID));
    store.writeListings(ID, {});
    store.writeAlertState(ID, {});
    store.markRead(ID, ['a1']);
    const names = fs.readdirSync(path.join(dir, 'watches', ID));
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), []);
  });

  test('listWatchIds returns valid watch ids, newest first', () => {
    assert.deepEqual(store.listWatchIds(), []);
    const older = '20261110-080000-old-search';
    const newer = '20261114-090507-new-search';
    const middle = '20261112-120000-middle-search';
    store.create(watchFixture(older));
    store.create(watchFixture(newer));
    store.create(watchFixture(middle));
    fs.mkdirSync(path.join(dir, 'watches', 'junk'));
    fs.mkdirSync(path.join(dir, 'watches', '20261115-000000-no-watch-json'));
    assert.deepEqual(store.listWatchIds(), [newer, middle, older]);
  });

  test('every method taking an id throws on an invalid id', () => {
    const bad = '../x';
    const calls = [
      () => store.readWatch(bad),
      () => store.writeWatch({ id: bad }),
      () => store.readListings(bad),
      () => store.writeListings(bad, {}),
      () => store.readAlertState(bad),
      () => store.writeAlertState(bad, {}),
      () => store.appendPass(bad, {}),
      () => store.readPasses(bad),
      () => store.appendEvents(bad, []),
      () => store.readEvents(bad),
      () => store.appendAlerts(bad, []),
      () => store.readAlerts(bad),
      () => store.readReadIds(bad),
      () => store.markRead(bad, []),
    ];
    for (const call of calls) assert.throws(call, /Invalid watch id/);
    assert.throws(() => store.create({ id: bad }), /Invalid watch id/);
  });

  test('lock: a second acquire throws while the first is held; release frees it', () => {
    const release = store.acquireLock();
    assert.throws(() => store.acquireLock(), new RegExp(`Another watch is running \\(pid ${process.pid}\\)`));
    release();
    const again = store.acquireLock();
    again();
  });

  test('lock: a stale lock (dead pid) is replaced', () => {
    fs.mkdirSync(path.join(dir, 'watches'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'watches', '.lock'),
      JSON.stringify({ pid: 2147483646, startedAt: '2026-11-01T00:00:00.000Z' }),
    );
    const release = store.acquireLock();
    const held = JSON.parse(fs.readFileSync(path.join(dir, 'watches', '.lock'), 'utf8'));
    assert.equal(held.pid, process.pid);
    release();
    assert.equal(fs.existsSync(path.join(dir, 'watches', '.lock')), false);
  });

  test('release removes the lock only if it still holds our pid', () => {
    const release = store.acquireLock();
    fs.writeFileSync(
      path.join(dir, 'watches', '.lock'),
      JSON.stringify({ pid: 2147483646, startedAt: '2026-11-01T00:00:00.000Z' }),
    );
    release();
    assert.equal(fs.existsSync(path.join(dir, 'watches', '.lock')), true);
  });
});
