// Launches real Chrome on the dedicated profile with the debugging port open.
// Run it, log in to Facebook by hand (2FA included) the first time, and leave the window open.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config, cdpUrl } from '../src/config.js';
import { chromeCandidates } from '../src/platform.js';

const candidates = [config.chromePath, ...chromeCandidates()].filter(Boolean);

const chrome = candidates.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('Chrome not found. Set CHROME_PATH in .env.');
  process.exit(1);
}

// Don't start a second Chrome on the same port.
try {
  const res = await fetch(`${cdpUrl()}/json/version`);
  if (res.ok) {
    console.log(`Chrome is already listening on ${cdpUrl()}. Nothing to do.`);
    process.exit(0);
  }
} catch {
  // Not running yet: good.
}

fs.mkdirSync(config.profileDir, { recursive: true });

const args = [
  `--remote-debugging-port=${config.cdpPort}`,
  `--user-data-dir=${config.profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://www.facebook.com/',
];

const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
child.unref();

console.log(`Started Chrome
  profile: ${config.profileDir}
  CDP:     ${cdpUrl()}  (any program on this computer can control it; close Chrome when done)

First time? Log in to Facebook in that window by hand, then run: npm start`);
