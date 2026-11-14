import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DailyBudget } from '../src/guard.js';

// Made-up local dates for the fake clock.
const day1 = new Date(2026, 10, 14, 10, 0, 0);
const day1Late = new Date(2026, 10, 14, 23, 59, 0);
const day2 = new Date(2026, 10, 15, 0, 1, 0);

describe('DailyBudget', () => {
  let dir;
  let now;
  const clock = () => now;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    now = day1;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('counts visits and reports what is left', () => {
    const b = new DailyBudget({ dir, max: 3, now: clock });
    assert.equal(b.used(), 0);
    assert.equal(b.left(), 3);
    b.spend();
    b.spend();
    assert.equal(b.used(), 2);
    assert.equal(b.left(), 1);
  });

  test('the cap throws and the count stops at the cap', () => {
    const b = new DailyBudget({ dir, max: 2, now: clock });
    b.spend();
    b.spend();
    assert.throws(() => b.spend(), /Daily visit cap of 2 reached\./);
    assert.equal(b.used(), 2);
    assert.equal(b.left(), 0);
  });

  test('left never goes below zero', () => {
    const b = new DailyBudget({ dir, max: 0, now: clock });
    assert.equal(b.left(), 0);
    assert.throws(() => b.spend(), /Daily visit cap of 0 reached\./);
  });

  test('a new local day starts at zero', () => {
    const b = new DailyBudget({ dir, max: 2, now: clock });
    b.spend();
    b.spend();
    now = day1Late;
    assert.equal(b.used(), 2);
    now = day2;
    assert.equal(b.used(), 0);
    assert.equal(b.left(), 2);
    b.spend();
    assert.equal(b.used(), 1);
  });

  test('file shape: visits-YYYY-MM-DD.json holds { date, used }', () => {
    const b = new DailyBudget({ dir, max: 5, now: clock });
    b.spend();
    b.spend();
    const file = path.join(dir, 'visits-2026-11-14.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { date: '2026-11-14', used: 2 });
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });

  test('creates the folder when it is missing', () => {
    const nested = path.join(dir, 'nested', 'out');
    const b = new DailyBudget({ dir: nested, max: 5, now: clock });
    b.spend();
    assert.equal(b.used(), 1);
    assert.ok(fs.existsSync(path.join(nested, 'visits-2026-11-14.json')));
  });

  test('an unreadable or foreign file counts as zero', () => {
    fs.writeFileSync(path.join(dir, 'visits-2026-11-14.json'), '{not json');
    const b = new DailyBudget({ dir, max: 2, now: clock });
    assert.equal(b.used(), 0);
    fs.writeFileSync(
      path.join(dir, 'visits-2026-11-14.json'),
      JSON.stringify({ date: '2026-11-13', used: 9 }),
    );
    assert.equal(b.used(), 0);
  });
});
