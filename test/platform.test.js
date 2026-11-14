import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfileDir, chromeCandidates } from '../src/platform.js';

test('defaultProfileDir picks the usual per-user data dir on each OS', () => {
  assert.equal(
    defaultProfileDir('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'),
    'C:\\Users\\me\\AppData\\Local\\pst\\chrome-profile',
  );
  assert.equal(
    defaultProfileDir('win32', {}, 'C:\\Users\\me'),
    'C:\\Users\\me\\AppData\\Local\\pst\\chrome-profile',
  );
  assert.equal(
    defaultProfileDir('darwin', {}, '/Users/me'),
    '/Users/me/Library/Application Support/pst/chrome-profile',
  );
  assert.equal(defaultProfileDir('linux', {}, '/home/me'), '/home/me/.local/share/pst/chrome-profile');
  assert.equal(defaultProfileDir('linux', { XDG_DATA_HOME: '/data' }, '/home/me'), '/data/pst/chrome-profile');
});

test('chromeCandidates lists the right binaries per OS', () => {
  const win = chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Users\\me');
  assert.equal(win[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(win.every((p) => p.endsWith('chrome.exe')));

  const mac = chromeCandidates('darwin', {}, '/Users/me');
  assert.deepEqual(mac, [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]);

  assert.ok(chromeCandidates('linux', {}, '/home/me').includes('/usr/bin/google-chrome'));
});
