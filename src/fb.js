// Facebook navigation. Selectors on facebook.com change often: prefer roles,
// aria-labels and visible text over class names, and keep them all in this file.
import { pause, scroll } from './human.js';
import { waitIfBlocked } from './guard.js';

const FB = 'https://www.facebook.com';

export class Facebook {
  /**
   * @param {import('playwright-core').Page} page
   * @param {import('./guard.js').Budget} budget
   */
  constructor(page, budget) {
    this.page = page;
    this.budget = budget;
  }

  /** Go to a facebook.com path or full URL, then settle like a reader would. */
  async open(pathOrUrl) {
    this.budget.spend();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${FB}${pathOrUrl}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitIfBlocked(this.page);
    await pause();
  }

  async home() {
    await this.open('/');
  }

  /** The login page has an email box; the logged-in shell doesn't. */
  async isLoggedIn() {
    return (await this.page.locator('input[name="email"]').count()) === 0;
  }

  /** Open a group by id or slug, e.g. "123456789" or "mygroupname". */
  async group(idOrSlug) {
    await this.open(`/groups/${idOrSlug}`);
  }

  /** Open a page by its username or id. */
  async pageProfile(handle) {
    await this.open(`/${handle}`);
  }

  /** Scroll the current feed a bit. */
  async browseFeed(steps = 5) {
    await scroll(this.page, { steps });
    await pause();
  }

  /** Post containers in the current feed. */
  posts() {
    return this.page.locator('[role="feed"] > div');
  }

  /**
   * Text of the posts loaded so far. Rough on purpose: a starting point to adapt
   * to what you need from a group.
   */
  async readPosts(limit = 10) {
    const items = await this.posts().all();
    const out = [];
    for (const item of items.slice(0, limit)) {
      const text = (await item.innerText().catch(() => '')).trim();
      if (text) out.push(text);
    }
    return out;
  }
}
