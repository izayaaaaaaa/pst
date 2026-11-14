// Spots Facebook's security screens and hands control back to you, and caps how much a run does.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sleep } from './human.js';

const BLOCK_PATTERNS = [
  /\/checkpoint\//,
  /\/login(\/|\.php|\?|$)/,
  /two_step_verification/,
  /\/recover\//,
];

export const isBlocked = (url) => BLOCK_PATTERNS.some((re) => re.test(url));

/**
 * If the page is on a login or checkpoint screen, wait (up to `timeoutMs`) for you
 * to clear it in the Chrome window. Throws if it isn't cleared in time.
 */
export async function waitIfBlocked(page, { timeoutMs = 10 * 60_000 } = {}) {
  if (!isBlocked(page.url())) return;
  console.warn(
    `\n>> Facebook needs you: ${page.url()}\n>> Clear it in the Chrome window. Waiting up to ${timeoutMs / 60_000} min...`,
  );
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(3000);
    if (!isBlocked(page.url())) {
      console.log('>> Cleared, carrying on.');
      return;
    }
  }
  throw new Error('Checkpoint not cleared in time; stopping.');
}

/** Counts page visits and stops the run once the budget is spent. */
export class Budget {
  constructor(max) {
    this.max = max;
    this.used = 0;
  }

  spend() {
    if (this.used >= this.max) throw new Error(`Visit budget of ${this.max} used up for this run.`);
    this.used += 1;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Persisted per-day visit cap, shared by every run (D-007).
 * Counts live in `<dir>/visits-YYYY-MM-DD.json` as `{ date, used }`.
 */
export class DailyBudget {
  /**
   * @param {{ dir: string, max: number, now?: () => Date }} opts
   */
  constructor({ dir, max, now = () => new Date() }) {
    this.dir = dir;
    this.max = max;
    this.now = now;
  }

  #file(date) {
    return path.join(this.dir, `visits-${date}.json`);
  }

  #readUsed(date) {
    try {
      const data = JSON.parse(readFileSync(this.#file(date), 'utf8'));
      if (data?.date !== date || !Number.isInteger(data.used) || data.used < 0) return 0;
      return data.used;
    } catch {
      return 0;
    }
  }

  /** Visits counted today. */
  used() {
    return this.#readUsed(localDate(this.now()));
  }

  /** Visits still allowed today. */
  left() {
    return Math.max(0, this.max - this.used());
  }

  /** Counts one visit. Throws once today's cap is reached. */
  spend() {
    const date = localDate(this.now());
    const used = this.#readUsed(date);
    if (used >= this.max) throw new Error(`Daily visit cap of ${this.max} reached.`);
    mkdirSync(this.dir, { recursive: true });
    const file = this.#file(date);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ date, used: used + 1 }, null, 2));
    renameSync(tmp, file);
  }
}
