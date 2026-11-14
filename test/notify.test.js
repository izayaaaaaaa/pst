import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildCommand, alertsToNotifications, notify, WIN_TOAST_SCRIPT } from '../src/alerts/notify.js';

const INJECT = 'Test Item" & end tell & do shell script "rm -rf x';

test('buildCommand darwin passes the title as an argument, not inside the script', () => {
  const c = buildCommand('darwin', INJECT, 'Body');
  assert.equal(c.cmd, 'osascript');
  assert.deepEqual(c.env, {});
  assert.ok(c.args.includes(INJECT));
  for (const arg of c.args.slice(0, -2)) assert.ok(!arg.includes(INJECT));
  assert.deepEqual(c.args.slice(-2), [INJECT, 'Body']);
});

test('buildCommand win32 carries the text in env and keeps it out of the script', () => {
  const c = buildCommand('win32', INJECT, 'Body');
  assert.equal(c.cmd, 'powershell.exe');
  assert.equal(c.env.PST_TITLE, INJECT);
  assert.equal(c.env.PST_BODY, 'Body');
  assert.ok(!WIN_TOAST_SCRIPT.includes(INJECT));
  assert.ok(!c.args.join(' ').includes(INJECT));
  assert.equal(c.args[3], WIN_TOAST_SCRIPT);
});

test('buildCommand linux uses notify-send with -- before the text', () => {
  assert.deepEqual(buildCommand('linux', 'T', 'B'), {
    cmd: 'notify-send',
    args: ['--app-name=pst', '--', 'T', 'B'],
    env: {},
  });
});

test('buildCommand strips control characters and truncates', () => {
  const c = buildCommand('linux', 'a\u0007b\u001bc\nd', 'x'.repeat(300));
  assert.equal(c.args[2], 'a b c d');
  assert.equal(Array.from(c.args[3]).length, 200);
  assert.ok(c.args[3].endsWith('…'));
  const t = buildCommand('linux', 'y'.repeat(100), '');
  assert.equal(Array.from(t.args[2]).length, 64);
  assert.ok(t.args[2].endsWith('…'));
});

test('buildCommand returns null for an unknown platform', () => {
  assert.equal(buildCommand('aix', 'T', 'B'), null);
});

const alert = (n, over = {}) => ({
  id: `w:${n}`,
  title: `Test Item ${n}`,
  location: 'Test City',
  price: { amount: 100000 * n, currency: 'PHP', raw: '' },
  prevPrice: null,
  ...over,
});

test('alertsToNotifications lists up to 3 alerts one each', () => {
  const out = alertsToNotifications([alert(1), alert(2), alert(3)], { query: 'test phone' });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { title: 'pst · test phone', body: '₱1,000 · Test Item 1 · Test City' });
});

test('alertsToNotifications adds a summary after max-1 alerts', () => {
  const alerts = [1, 2, 3, 4, 5].map((n) => alert(n));
  const out = alertsToNotifications(alerts, { query: 'test phone' });
  assert.equal(out.length, 3);
  assert.equal(out[0].body, '₱1,000 · Test Item 1 · Test City');
  assert.equal(out[1].body, '₱2,000 · Test Item 2 · Test City');
  assert.equal(out[2].title, 'pst · test phone');
  assert.equal(out[2].body, '+3 more alerts for test phone, see the UI');
});

test('alertsToNotifications shows the previous price when there is one', () => {
  const a = alert(1, { prevPrice: { amount: 120000, currency: 'PHP' }, location: null });
  assert.deepEqual(alertsToNotifications([a], { query: 'q' }), [{ title: 'pst · q', body: '₱1,000 (was ₱1,200) · Test Item 1' }]);
});

test('notify spawns without a shell and does not log on exit 0', async () => {
  const calls = [];
  const logs = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
  await notify([{ title: 'T', body: 'B' }], { platform: 'linux', spawn, log: (m) => logs.push(m) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'notify-send');
  assert.equal(calls[0].opts.shell, undefined);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.deepEqual(logs, []);
});

test('notify logs the fallback on a non-zero exit and does not throw', async () => {
  const logs = [];
  const spawn = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 1));
    return child;
  };
  await notify([{ title: 'Title X', body: 'Body Y' }], { platform: 'darwin', spawn, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('Title X'));
  assert.ok(logs[0].includes('Body Y'));
  assert.ok(logs[0].endsWith('\x07'));
});

test('notify logs the fallback on an error event and does not throw', async () => {
  const logs = [];
  const spawn = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  await notify([{ title: 'T', body: 'B' }], { platform: 'linux', spawn, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
});

test('notify logs when the spawn call itself throws', async () => {
  const logs = [];
  const spawn = () => {
    throw new Error('bad args');
  };
  await notify([{ title: 'T', body: 'B' }], { platform: 'linux', spawn, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
});

test('notify logs when the platform has no command', async () => {
  const logs = [];
  let spawned = false;
  const spawn = () => {
    spawned = true;
  };
  await notify([{ title: 'T', body: 'B' }], { platform: null, spawn, log: (m) => logs.push(m) });
  assert.equal(spawned, false);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].endsWith('\x07'));
});

test('buildCommand neutralizes a leading dash so text is never read as an option', () => {
  const c = buildCommand('darwin', '-e', '--evil');
  assert.equal(c.args.at(-2), ' -e');
  assert.equal(c.args.at(-1), ' --evil');
  const l = buildCommand('linux', '-x', 'ok');
  assert.ok(!l.args.at(-2).startsWith('-'));
});

test('notify kills a hung child after the timeout and logs the fallback', async () => {
  const logs = [];
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.kill = () => { killed = true; };
    return child; // never exits
  };
  await notify([{ title: 't', body: 'b' }], { platform: 'darwin', spawn, log: (m) => logs.push(m), timeoutMs: 20 });
  assert.ok(killed);
  assert.equal(logs.length, 1);
});
