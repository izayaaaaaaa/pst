import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProfileDir } from './platform.js';

// Tests never read .env (mw-contracts §1): `node --test` sets NODE_TEST_CONTEXT in each test process.
if (!process.env.NODE_TEST_CONTEXT) dotenv.config();

const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};

const repoDir = fileURLToPath(new URL('..', import.meta.url));

export const config = {
  cdpPort: num('CDP_PORT', 9222),
  profileDir: process.env.CHROME_PROFILE_DIR || defaultProfileDir(),
  chromePath: process.env.CHROME_PATH || '',
  maxPageVisits: num('MAX_PAGE_VISITS', 15),
  maxDailyVisits: num('MAX_DAILY_VISITS', 60),
  minDelayMs: num('MIN_DELAY_MS', 2500),
  maxDelayMs: num('MAX_DELAY_MS', 7000),
  quietStartHour: num('QUIET_START_HOUR', 1),
  quietEndHour: num('QUIET_END_HOUR', 7),
  uiPort: num('UI_PORT', 5173),
  marketLocation: process.env.MARKET_LOCATION || '',
  marketRadiusKm: num('MARKET_RADIUS_KM', 6),
  marketCurrency: process.env.MARKET_CURRENCY || 'PHP',
  outputDir: process.env.OUTPUT_DIR || path.join(repoDir, 'output'),
};

export const cdpUrl = () => `http://127.0.0.1:${config.cdpPort}`;
