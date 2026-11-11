import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocked, Budget } from '../src/guard.js';
import { inQuietHours } from '../src/human.js';

test('isBlocked spots login and checkpoint URLs', () => {
  assert.ok(isBlocked('https://www.facebook.com/checkpoint/1501092823525282/'));
  assert.ok(isBlocked('https://www.facebook.com/login/?next=%2Fgroups'));
  assert.ok(isBlocked('https://www.facebook.com/login.php'));
  assert.ok(!isBlocked('https://www.facebook.com/groups/123'));
  assert.ok(!isBlocked('https://www.facebook.com/'));
});

test('Budget stops after max visits', () => {
  const b = new Budget(2);
  b.spend();
  b.spend();
  assert.throws(() => b.spend(), /budget/);
});

test('inQuietHours handles normal and wrapping windows', () => {
  assert.ok(inQuietHours(3, 1, 7));
  assert.ok(!inQuietHours(7, 1, 7));
  assert.ok(inQuietHours(23, 22, 6));
  assert.ok(inQuietHours(2, 22, 6));
  assert.ok(!inQuietHours(12, 22, 6));
  assert.ok(!inQuietHours(3, 5, 5));
});
