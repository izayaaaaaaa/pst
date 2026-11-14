import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detailsAllowed, nextPassDelay, skipQuietHours, runWatch } from '../src/watch/runner.js';
import { WatchStore } from '../src/watch/store.js';
import { parseRules } from '../src/alerts/rules.js';

// All data here is made up.
const T0 = new Date(2026, 10, 14, 12, 0, 0); // local noon, outside quiet hours
const MIN = 60_000;
const ID = {
  A: '1000000000000001',
  B: '1000000000000002',
  C: '1000000000000003',
  D: '1000000000000004',
};

const rawCard = (id, price, title, location = 'Test City') => ({
  href: `https://www.facebook.com/marketplace/item/${id}/`,
  text: [price, title, location].filter(Boolean).join('\n'),
  img: null,
});

const rawDetail = (title, priceText) => ({
  title,
  priceText,
  labelText: null,
  description: 'Test description',
  sellerName: 'Juan Test',
  postedText: 'Listed today',
  condition: 'Used - Good',
});

function makeSpec(over = {}) {
  return {
    query: 'test phone',
    filters: { minPrice: null, maxPrice: null, location: null, radiusKm: 6, daysSinceListed: null },
    times: 3,
    until: null,
    everyMs: 30 * MIN,
    maxListings: 40,
    detailsPerPass: 0,
    alerts: [],
    desktop: true,
    currency: 'PHP',
    ...over,
  };
}

/**
 * Fake everything. `passes[i]` scripts search pass i+1 (the last entry repeats):
 * { cards: raw[], error?: string, searchArea?: string|null, onRead?: () => void }
 */
function makeHarness({ passes = [], details = {}, daily = 100, rand = () => 0.5, signal, notifyError } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
  const store = new WatchStore(dir);
  let t = T0.getTime();
  const calls = { searches: 0, opened: [], attaches: 0, detaches: 0, notified: [], lines: [] };
  const script = () => passes[Math.min(calls.searches, passes.length) - 1] ?? {};

  const deps = {
    store,
    daily: { left: () => daily },
    attach: async () => {
      calls.attaches += 1;
      return {
        page: {},
        detach: async () => {
          calls.detaches += 1;
        },
      };
    },
    makeFacebook: () => ({
      async marketplaceSearch() {
        calls.searches += 1;
      },
      async readSearchArea() {
        return 'searchArea' in script() ? script().searchArea : 'Test area 6 km';
      },
      async readListingCards() {
        const s = script();
        if (s.error) throw new Error(s.error);
        s.onRead?.();
        return s.cards ?? [];
      },
      async readListingDetail(id) {
        calls.opened.push(id);
        return details[id] ?? rawDetail('Test Item', null);
      },
    }),
    notify: async (alerts) => {
      calls.notified.push(alerts);
      if (notifyError) throw notifyError;
    },
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    rand,
    log: (line) => calls.lines.push(line),
    quiet: { start: 0, end: 0 },
    signal,
  };
  return {
    deps,
    store,
    calls,
    clock: () => t,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('detailsAllowed', () => {
  test('caps at k, the queue, and visits left after the remaining searches', () => {
    assert.equal(detailsAllowed({ k: 5, queued: Infinity, left: 60, searchesRemaining: 17 }), 5);
    assert.equal(detailsAllowed({ k: 50, queued: Infinity, left: 60, searchesRemaining: 17 }), 43);
    assert.equal(detailsAllowed({ k: 50, queued: 2, left: 60, searchesRemaining: 17 }), 2);
    assert.equal(detailsAllowed({ k: 50, queued: Infinity, left: 10, searchesRemaining: 17 }), 0);
  });

  test('plan example: 60 a day, 17 passes, so 43 spare visits for details', () => {
    assert.equal(detailsAllowed({ k: 100, queued: Infinity, left: 60, searchesRemaining: 17 }), 43);
  });
});

describe('nextPassDelay', () => {
  test('stays within ±20% of everyMs', () => {
    assert.equal(nextPassDelay(1000, () => 0), 800);
    assert.equal(nextPassDelay(1000, () => 0.5), 1000);
    const top = nextPassDelay(1000, () => 0.999999);
    assert.ok(top >= 1199 && top < 1200, `top was ${top}`);
  });
});

describe('skipQuietHours', () => {
  test('inside the window moves to the next endHour:00', () => {
    const d = skipQuietHours(new Date(2026, 10, 14, 3, 30), 1, 7);
    assert.equal(d.getTime(), new Date(2026, 10, 14, 7, 0, 0).getTime());
  });

  test('outside the window is unchanged', () => {
    const at = new Date(2026, 10, 14, 12, 15);
    assert.equal(skipQuietHours(at, 1, 7).getTime(), at.getTime());
  });

  test('a window that wraps midnight: late evening moves to tomorrow morning', () => {
    const d = skipQuietHours(new Date(2026, 10, 14, 23, 0), 22, 6);
    assert.equal(d.getTime(), new Date(2026, 10, 15, 6, 0, 0).getTime());
  });

  test('a window that wraps midnight: early morning moves to this morning', () => {
    const d = skipQuietHours(new Date(2026, 10, 14, 2, 0), 22, 6);
    assert.equal(d.getTime(), new Date(2026, 10, 14, 6, 0, 0).getTime());
  });
});

describe('runWatch', () => {
  test('3 passes: baseline, a new listing, a price drop with an alert, and notify is called', async () => {
    const passes = [
      { cards: [rawCard(ID.A, '₱25,000', 'Test Phone 128GB'), rawCard(ID.B, '₱15,000', 'Test Radio')] },
      {
        cards: [
          rawCard(ID.A, '₱25,000', 'Test Phone 128GB'),
          rawCard(ID.B, '₱15,000', 'Test Radio'),
          rawCard(ID.C, '₱9,000', 'Test Charger'),
        ],
      },
      {
        cards: [
          rawCard(ID.A, '₱22,000', 'Test Phone 128GB'),
          rawCard(ID.B, '₱15,000', 'Test Radio'),
          rawCard(ID.C, '₱9,000', 'Test Charger'),
        ],
      },
    ];
    const h = makeHarness({ passes });
    try {
      const spec = makeSpec({ alerts: parseRules(['drop>=2000']) });
      const watch = await runWatch(spec, h.deps);

      assert.equal(watch.status, 'done');
      assert.equal(watch.passesDone, 3);
      assert.equal(watch.nextPassAt, null);
      const events = h.store.readEvents(watch.id);
      assert.deepEqual(
        events.map((e) => [e.pass, e.type, e.listingId]),
        [
          [2, 'new', ID.C],
          [3, 'price_drop', ID.A],
        ],
      );
      const alerts = h.store.readAlerts(watch.id);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].ruleText, 'drop>=2000');
      assert.equal(alerts[0].listingId, ID.A);
      assert.equal(alerts[0].pass, 3);
      assert.equal(h.calls.notified.length, 1);
      assert.equal(h.calls.notified[0].length, 1);
      assert.equal(h.store.readPasses(watch.id).every((p) => p.ok), true);
      assert.equal(h.calls.attaches, 3);
      assert.equal(h.calls.detaches, 3);
    } finally {
      h.cleanup();
    }
  });

  test('desktop: false stores alerts but sends no notification', async () => {
    const passes = [
      { cards: [rawCard(ID.A, '₱25,000', 'Test Phone 128GB')] },
      { cards: [rawCard(ID.A, '₱20,000', 'Test Phone 128GB')] },
    ];
    const h = makeHarness({ passes });
    try {
      const spec = makeSpec({ times: 2, desktop: false, alerts: parseRules(['drop>=2000']) });
      const watch = await runWatch(spec, h.deps);
      assert.equal(h.store.readAlerts(watch.id).length, 1);
      assert.equal(h.calls.notified.length, 0);
    } finally {
      h.cleanup();
    }
  });

  test('a notification error is logged and does not stop the watch', async () => {
    const passes = [
      { cards: [rawCard(ID.A, '₱25,000', 'Test Phone 128GB')] },
      { cards: [rawCard(ID.A, '₱20,000', 'Test Phone 128GB')] },
    ];
    const h = makeHarness({ passes, notifyError: new Error('no display') });
    try {
      const spec = makeSpec({ times: 2, alerts: parseRules(['drop>=2000']) });
      const watch = await runWatch(spec, h.deps);
      assert.equal(watch.status, 'done');
      assert.ok(h.calls.lines.some((l) => l.includes('Notification failed: no display')));
    } finally {
      h.cleanup();
    }
  });

  test('details are opened in queue order, up to k', async () => {
    const passes = [
      {
        cards: [
          rawCard(ID.A, '₱25,000', 'Test Phone 128GB'),
          rawCard(ID.B, '₱15,000', 'Test Radio'),
          rawCard(ID.C, null, 'Test Lamp'),
          rawCard(ID.D, '₱9,000', 'Test Charger'),
        ],
      },
    ];
    const h = makeHarness({
      passes,
      details: {
        [ID.D]: rawDetail('Test Charger', '₱9,000'),
        [ID.B]: rawDetail('Test Radio', '₱15,000'),
      },
    });
    try {
      const watch = await runWatch(makeSpec({ times: 1, detailsPerPass: 2 }), h.deps);
      assert.deepEqual(h.calls.opened, [ID.D, ID.B]);
      const [pass] = h.store.readPasses(watch.id);
      assert.equal(pass.detailsOpened, 2);
      assert.equal(pass.visits, 3);
      const listings = h.store.readListings(watch.id);
      assert.equal(listings[ID.D].detail.sellerName, 'Juan Test');
      assert.equal(listings[ID.A].detail, null);
    } finally {
      h.cleanup();
    }
  });

  test('not enough daily visits at the start throws and creates nothing', async () => {
    const h = makeHarness({ passes: [{ cards: [] }], daily: 2 });
    try {
      await assert.rejects(
        runWatch(makeSpec({ times: 3 }), h.deps),
        /Only 2 visits left today; 2 passes would fit\./,
      );
      assert.equal(h.calls.attaches, 0);
      assert.deepEqual(h.store.listWatchIds(), []);
    } finally {
      h.cleanup();
    }
  });

  test('a checkpoint stops with stopped_checkpoint and detaches', async () => {
    const h = makeHarness({
      passes: [{ error: 'Checkpoint not cleared in time; stopping.' }],
    });
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'stopped_checkpoint');
      assert.equal(watch.passesDone, 1);
      assert.equal(h.calls.attaches, 1);
      assert.equal(h.calls.detaches, 1);
      assert.equal(h.store.readPasses(watch.id)[0].ok, false);
    } finally {
      h.cleanup();
    }
  });

  test('a daily cap error stops with stopped_budget', async () => {
    const h = makeHarness({ passes: [{ error: 'Daily visit cap of 60 reached.' }] });
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'stopped_budget');
      assert.equal(h.calls.attaches, 1);
    } finally {
      h.cleanup();
    }
  });

  test('2 consecutive generic failures stop with error, detaching each time', async () => {
    const h = makeHarness({
      passes: [{ error: 'boom' }, { error: 'boom' }, { cards: [rawCard(ID.A, '₱1,000', 'Test Item')] }],
    });
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'error');
      assert.equal(watch.lastError, 'boom');
      assert.equal(watch.passesDone, 2);
      assert.equal(h.calls.attaches, 2);
      assert.equal(h.calls.detaches, 2);
      assert.equal(h.calls.searches, 2);
    } finally {
      h.cleanup();
    }
  });

  test('one failure then success continues to the end', async () => {
    const h = makeHarness({
      passes: [{ error: 'boom' }, { cards: [rawCard(ID.A, '₱1,000', 'Test Item')] }],
    });
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'done');
      assert.equal(watch.passesDone, 3);
      assert.equal(watch.lastError, null);
      assert.deepEqual(
        h.store.readPasses(watch.id).map((p) => p.ok),
        [false, true, true],
      );
      assert.equal(h.calls.detaches, 3);
    } finally {
      h.cleanup();
    }
  });

  test('until stops before the first pass that would start after it', async () => {
    const h = makeHarness({ passes: [{ cards: [rawCard(ID.A, '₱1,000', 'Test Item')] }], rand: () => 0.5 });
    try {
      const until = new Date(T0.getTime() + 25 * MIN).toISOString();
      const watch = await runWatch(makeSpec({ times: 5, everyMs: 10 * MIN, until }), h.deps);
      assert.equal(watch.status, 'done');
      assert.equal(watch.passesDone, 3); // passes at +0, +10, +20; the +30 pass is past until
      assert.equal(h.calls.searches, 3);
    } finally {
      h.cleanup();
    }
  });

  test('abort after a pass stops with stopped, keeping that pass', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      passes: [{ cards: [rawCard(ID.A, '₱1,000', 'Test Item')], onRead: () => controller.abort() }],
      signal: controller.signal,
    });
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'stopped');
      assert.equal(watch.passesDone, 1);
      assert.equal(h.calls.searches, 1);
      assert.equal(h.calls.detaches, 1);
      assert.equal(h.store.readPasses(watch.id).length, 1);
    } finally {
      h.cleanup();
    }
  });

  test('an abort during the wait stops before the next search', async () => {
    const controller = new AbortController();
    const h = makeHarness({
      passes: [{ cards: [rawCard(ID.A, '₱1,000', 'Test Item')] }],
      signal: controller.signal,
    });
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms) => {
      controller.abort();
      await sleep(ms);
    };
    try {
      const watch = await runWatch(makeSpec({ times: 3 }), h.deps);
      assert.equal(watch.status, 'stopped');
      assert.equal(h.calls.searches, 1);
    } finally {
      h.cleanup();
    }
  });
});
