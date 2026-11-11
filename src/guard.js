// Spots Facebook's security screens and hands control back to you, and caps how much a run does.
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
