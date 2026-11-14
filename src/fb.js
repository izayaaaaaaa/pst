// Facebook navigation. Selectors on facebook.com change often: prefer roles,
// aria-labels and visible text over class names, and keep them all in this file.
import { pause, scroll } from './human.js';
import { waitIfBlocked } from './guard.js';
import { detailFieldsFromText } from './market/parse.js';

const FB = 'https://www.facebook.com';

// Item links in search results and the item id they carry (kept local so this file stays
// independent of parse.js; the id format is the same as itemIdFromHref).
const ITEM_LINK = 'a[href*="/marketplace/item/"]';
const ITEM_ID_RE = /\/marketplace\/item\/(\d+)/;
const MAX_SCROLL_ROUNDS = 10;

/**
 * Marketplace search URL for a query and filters. Whole-unit prices, like Facebook's URL.
 * @param {string} query
 * @param {{ location?: string|null, minPrice?: number|null, maxPrice?: number|null,
 *           daysSinceListed?: number|null, radiusKm?: number|null }} [opts]
 * @returns {string}
 */
export function marketplaceSearchUrl(
  query,
  { location, minPrice, maxPrice, daysSinceListed, radiusKm } = {},
) {
  const base = location
    ? `${FB}/marketplace/${encodeURIComponent(location)}/search`
    : `${FB}/marketplace/search`;
  const params = new URLSearchParams();
  const add = (key, value) => {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  };
  add('query', query);
  add('minPrice', minPrice);
  add('maxPrice', maxPrice);
  add('daysSinceListed', daysSinceListed);
  add('radius', radiusKm);
  params.set('sortBy', 'creation_time_descend');
  params.set('exact', 'false');
  return `${base}?${params}`;
}

/** Resolve a path or URL and refuse anything that isn't https on facebook.com (checked before any budget is spent). */
export function facebookUrl(pathOrUrl) {
  const u = new URL(pathOrUrl, FB);
  if (u.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(u.hostname)) {
    throw new Error(`Refusing to open non-Facebook URL: ${u.origin}`);
  }
  return u.href;
}

export class Facebook {
  /**
   * @param {import('playwright-core').Page} page
   * @param {import('./guard.js').Budget} budget
   * @param {{ daily?: import('./guard.js').DailyBudget }} [opts]
   */
  constructor(page, budget, opts = {}) {
    if (opts === null || typeof opts !== 'object' || typeof opts.spend === 'function') {
      throw new TypeError('Facebook options must be { daily }, not a budget object');
    }
    const { daily } = opts;
    this.page = page;
    this.budget = budget;
    this.daily = daily;
  }

  /** Go to a facebook.com path or full URL, then settle like a reader would. */
  async open(pathOrUrl) {
    const url = facebookUrl(pathOrUrl);
    this.budget.spend();
    this.daily?.spend();
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

  /**
   * Open a Marketplace search for `query` with the given filters.
   * @param {string} query
   * @param {{ location?: string|null, minPrice?: number|null, maxPrice?: number|null,
   *           daysSinceListed?: number|null, radiusKm?: number|null }} [filters]
   */
  async marketplaceSearch(query, filters = {}) {
    await this.open(marketplaceSearchUrl(query, filters));
  }

  /**
   * Item cards on the current search page, scrolling to load more. Stops at `max` cards,
   * after 2 rounds in a row with no new cards, or after 10 scroll rounds.
   * @param {number} [max=40]
   * @returns {Promise<{ href: string, text: string, img: string|null }[]>}
   */
  async readListingCards(max = 40) {
    const seen = new Map(); // item id -> raw card
    let stale = 0;
    for (let scrolls = 0; ; scrolls++) {
      // TUNE LIVE: item links and their text/image on the search results grid.
      const found = await this.page.locator(ITEM_LINK).evaluateAll((links) =>
        links.map((a) => ({
          href: a.href,
          text: a.innerText ?? '',
          img: a.querySelector('img')?.getAttribute('src') ?? null,
        })),
      );
      let added = 0;
      for (const card of found) {
        const id = card.href.match(ITEM_ID_RE)?.[1];
        if (!id || seen.has(id)) continue;
        seen.set(id, card);
        added += 1;
        if (seen.size >= max) break;
      }
      if (seen.size >= max) break;
      stale = added ? 0 : stale + 1;
      if (stale >= 2 || scrolls >= MAX_SCROLL_ROUNDS) break;
      await scroll(this.page, { steps: 1 });
    }
    return [...seen.values()].slice(0, max);
  }

  /**
   * Best-guess text of the location/radius chip on a search page, e.g. "Pasig · Within 6 km".
   * Null if not found. Never throws.
   * @returns {Promise<string|null>}
   */
  async readSearchArea() {
    try {
      // TUNE LIVE: the location chip is a short element that mentions km.
      const text = await this.page.evaluate(() => {
        const re = /\b\d+(\.\d+)?\s*km\b/i;
        for (const el of document.querySelectorAll('[role="button"], [role="link"], span, div')) {
          const t = (el.innerText ?? '').trim();
          if (t && t.length <= 60 && re.test(t) && el.children.length <= 2) return t;
        }
        return null;
      });
      return text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Open an item page and read its raw fields. Each field is null when not found.
   * Only navigation errors throw.
   * @param {string} id
   * @returns {Promise<{ title: string|null, priceText: string|null, labelText: string|null,
   *   description: string|null, sellerName: string|null, postedText: string|null,
   *   condition: string|null }>}
   */
  async readListingDetail(id) {
    await this.open(`/marketplace/item/${id}/`);
    try {
      // The visible text carries every field in a stable order; parse.js anchors on labels and
      // line order, so Marketplace's obfuscated class names never matter here. The page can hold
      // more than one h1 (a hidden chats/messenger heading), so prefer a visible non-generic one.
      const page = await this.page.evaluate(() => {
        const generic = /^(marketplace|chats|notifications|facebook|buy and sell groups)$/i;
        const h1s = [...document.querySelectorAll('h1')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => (el.innerText ?? '').trim())
          .filter((t) => t && !generic.test(t));
        const ogTitle = (document.querySelector('meta[property="og:title"]')?.content ?? '').trim();
        return {
          text: document.body.innerText ?? '',
          title: h1s[0] ?? (ogTitle && !generic.test(ogTitle) ? ogTitle : null),
        };
      });
      return detailFieldsFromText(page);
    } catch {
      return {
        title: null,
        priceText: null,
        labelText: null,
        description: null,
        sellerName: null,
        postedText: null,
        condition: null,
      };
    }
  }

  /**
   * Diagnostic dump of an item page for selector tuning (`--raw-detail`). Not used by watch runs.
   * Opens the page (one visit), so the caller's budget must allow it.
   * @param {string} id
   */
  async dumpListingDetail(id) {
    await this.open(`/marketplace/item/${id}/`);
    return this.page.evaluate(() => {
      const txt = (el) => (el?.innerText ?? '').trim() || null;
      const html = (el) => (el?.outerHTML ?? '').slice(0, 2500);
      const leaves = [...document.querySelectorAll('span, div, h1, h2, h3, h4')].filter(
        (el) => el.childElementCount === 0,
      );
      const findLeaf = (re) => leaves.find((e) => re.test((e.textContent ?? '').trim()));
      const up = (el) => {
        let node = el;
        for (let i = 0; i < 5 && node && node !== document.body; i++) node = node.parentElement;
        return node;
      };
      return {
        url: location.href,
        h1Texts: [...document.querySelectorAll('h1')].map((el) => ({
          text: (el.innerText ?? '').trim(),
          visible: el.getClientRects().length > 0,
        })),
        ogTitle: (document.querySelector('meta[property="og:title"]')?.content ?? '').trim() || null,
        text: (document.body.innerText ?? '').slice(0, 6000),
        h1Html: html(document.querySelector('h1')),
        priceCandidates: [...document.querySelectorAll('span')]
          .map((e) => (e.textContent ?? '').trim())
          .filter((t) => t && t.length < 24 && /^(₱|\$|€|£|PHP|USD)\s?[\d,]+/.test(t))
          .slice(0, 5),
        sellerHtml: html(findLeaf(/^Seller/i) ? up(findLeaf(/^Seller/i)) : null),
        detailsHtml: html(findLeaf(/^(Details|Description)$/i) ? up(findLeaf(/^(Details|Description)$/i)) : null),
        conditionHtml: html(findLeaf(/^Condition$/i) ? up(findLeaf(/^Condition$/i)) : null),
      };
    });
  }
}
