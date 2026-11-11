import { chromium } from 'playwright-core';
import { cdpUrl } from './config.js';

/**
 * Attach to the Chrome started by `npm run chrome`.
 * Returns the existing context (with your cookies) and a page to work in.
 */
export async function attach({ newTab = true } = {}) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl());
  } catch (err) {
    throw new Error(
      `Can't reach Chrome at ${cdpUrl()}. Start it with "npm run chrome" first.\n(${err.message})`,
    );
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome has no browser context. Is it fully started?');

  // A fresh tab keeps the script out of whatever you're doing by hand.
  const page = newTab ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));

  /** Close our tab (if we opened it) and disconnect. Chrome itself stays open. */
  const detach = async () => {
    if (newTab && !page.isClosed()) await page.close().catch(() => {});
    await browser.close(); // on a CDP connection this only disconnects
  };

  return { browser, context, page, detach };
}
