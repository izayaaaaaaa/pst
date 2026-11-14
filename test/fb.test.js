import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the pauses at zero. Set before the dynamic import, because config reads env on load.
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';

let fbMod;
let guardMod;
before(async () => {
  fbMod = await import('../src/fb.js');
  guardMod = await import('../src/guard.js');
});

/** Fake page: records goto calls and reports a logged-in home URL. */
function fakePage(log) {
  return {
    goto: async (url) => {
      log.push(`goto ${url}`);
    },
    url: () => 'https://www.facebook.com/',
  };
}

describe('marketplaceSearchUrl', () => {
  test('no location, no filters: fixed sort and exact params only after the query', () => {
    const url = fbMod.marketplaceSearchUrl('Test Phone 128GB');
    assert.equal(
      url,
      'https://www.facebook.com/marketplace/search?query=Test+Phone+128GB&sortBy=creation_time_descend&exact=false',
    );
  });

  test('with a location: the path carries the encoded location', () => {
    const url = fbMod.marketplaceSearchUrl('test bike', { location: 'Test City & Co' });
    assert.ok(url.startsWith('https://www.facebook.com/marketplace/Test%20City%20%26%20Co/search?'));
    assert.ok(url.includes('query=test+bike'));
  });

  test('with all filters: params in contract order, null and empty skipped', () => {
    const url = fbMod.marketplaceSearchUrl('Test Phone', {
      location: null,
      minPrice: 1000,
      maxPrice: 25000,
      daysSinceListed: 7,
      radiusKm: 6,
    });
    const params = [...new URL(url).searchParams.keys()];
    assert.deepEqual(params, ['query', 'minPrice', 'maxPrice', 'daysSinceListed', 'radius', 'sortBy', 'exact']);
    const sp = new URL(url).searchParams;
    assert.equal(sp.get('minPrice'), '1000');
    assert.equal(sp.get('maxPrice'), '25000');
    assert.equal(sp.get('daysSinceListed'), '7');
    assert.equal(sp.get('radius'), '6');
    assert.equal(url.includes('marketplace/search?'), true);
  });

  test('empty strings and undefined are skipped', () => {
    const url = fbMod.marketplaceSearchUrl('', { minPrice: 0, maxPrice: undefined, radiusKm: '' });
    const sp = new URL(url).searchParams;
    assert.equal(sp.has('query'), false);
    assert.equal(sp.get('minPrice'), '0');
    assert.equal(sp.has('maxPrice'), false);
    assert.equal(sp.has('radius'), false);
  });
});

describe('Facebook.open', () => {
  test('spends the run budget and the daily budget before goto', async () => {
    const log = [];
    const budget = { spend: () => log.push('budget') };
    const daily = { spend: () => log.push('daily') };
    const fb = new fbMod.Facebook(fakePage(log), budget, { daily });
    await fb.open('/marketplace/search');
    assert.deepEqual(log, ['budget', 'daily', 'goto https://www.facebook.com/marketplace/search']);
  });

  test('a spent daily cap stops the visit before goto', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    try {
      const log = [];
      const daily = new guardMod.DailyBudget({ dir, max: 0 });
      const fb = new fbMod.Facebook(fakePage(log), new guardMod.Budget(5), { daily });
      await assert.rejects(fb.open('/'), /Daily visit cap of 0 reached/);
      assert.deepEqual(log, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real DailyBudget counts each open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    try {
      const log = [];
      const daily = new guardMod.DailyBudget({ dir, max: 2 });
      const fb = new fbMod.Facebook(fakePage(log), new guardMod.Budget(5), { daily });
      await fb.open('/');
      await fb.open('/');
      await assert.rejects(fb.open('/'), /Daily visit cap/);
      assert.equal(daily.used(), 2);
      assert.equal(log.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a daily budget, open works as before', async () => {
    const log = [];
    const fb = new fbMod.Facebook(fakePage(log), new guardMod.Budget(1));
    await fb.open('/');
    assert.equal(log.length, 1);
    await assert.rejects(fb.open('/'), /Visit budget of 1/);
  });

  test('marketplaceSearch opens the search URL through open()', async () => {
    const log = [];
    const fb = new fbMod.Facebook(fakePage(log), new guardMod.Budget(2));
    await fb.marketplaceSearch('Test Phone', { minPrice: 500 });
    assert.equal(log.length, 1);
    assert.ok(log[0].startsWith('goto https://www.facebook.com/marketplace/search?query=Test+Phone&minPrice=500'));
  });
});

describe('review fixes', () => {
  test('facebookUrl resolves paths and refuses other hosts or plain http', () => {
    assert.equal(fbMod.facebookUrl('/groups/1'), 'https://www.facebook.com/groups/1');
    assert.equal(fbMod.facebookUrl('https://facebook.com/x'), 'https://facebook.com/x');
    assert.throws(() => fbMod.facebookUrl('https://evil.example/'), /non-Facebook/);
    assert.throws(() => fbMod.facebookUrl('http://www.facebook.com/'), /non-Facebook/);
    assert.throws(() => fbMod.facebookUrl('https://www.facebook.com.evil.example/'), /non-Facebook/);
  });

  test('open() refuses a non-Facebook URL before spending any budget', async () => {
    const log = [];
    const budget = new guardMod.Budget(5);
    let dailySpent = 0;
    const fb = new fbMod.Facebook(fakePage(log), budget, { daily: { spend: () => { dailySpent++; } } });
    await assert.rejects(fb.open('https://evil.example/'), /non-Facebook/);
    assert.equal(budget.used, 0);
    assert.equal(dailySpent, 0);
    assert.deepEqual(log, []);
  });

  test('constructor rejects a budget passed where { daily } belongs', () => {
    const daily = { spend() {}, left() { return 1; } };
    assert.throws(() => new fbMod.Facebook(fakePage([]), new guardMod.Budget(1), daily), /\{ daily \}/);
  });
});
