import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};

function defaultProfileDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'pst', 'chrome-profile');
}

export const config = {
  cdpPort: num('CDP_PORT', 9222),
  profileDir: process.env.CHROME_PROFILE_DIR || defaultProfileDir(),
  chromePath: process.env.CHROME_PATH || '',
  maxPageVisits: num('MAX_PAGE_VISITS', 15),
  minDelayMs: num('MIN_DELAY_MS', 2500),
  maxDelayMs: num('MAX_DELAY_MS', 7000),
  quietStartHour: num('QUIET_START_HOUR', 1),
  quietEndHour: num('QUIET_END_HOUR', 7),
};

export const cdpUrl = () => `http://127.0.0.1:${config.cdpPort}`;
