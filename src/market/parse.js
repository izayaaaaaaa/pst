// Pure parsing of Marketplace cards and detail pages. No I/O, no config imports.

/**
 * @typedef {{ amount: number|null, currency: string|null, raw: string }} Price
 * amount is in minor units (centavos); null when unknown.
 */

const SYMBOL_CURRENCY = { '₱': 'PHP', '$': 'USD', '€': 'EUR', '£': 'GBP' };
const CODES = ['PHP', 'USD', 'EUR', 'GBP'];

// Symbol or code, optional space, then a number with thousands commas and optional decimals.
const PRICE_RE = new RegExp(
  '(?:(₱|\\$|€|£)\\s*|(?<![A-Za-z])(' + CODES.join('|') + ')(?![A-Za-z])\\s*)' +
  '(\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?)'
);
const FREE_RE = /(?<![\p{L}\p{N}])Free(?![\p{L}\p{N}])/iu;
const ITEM_RE = /\/marketplace\/item\/(\d+)/;

/**
 * Item id from an absolute or relative marketplace item href.
 * @param {unknown} href
 * @returns {string|null}
 */
export function itemIdFromHref(href) {
  if (typeof href !== 'string') return null;
  const m = ITEM_RE.exec(href);
  return m ? m[1] : null;
}

/**
 * The first price in text. `Free` (whole token) is a price of 0.
 * @param {unknown} text
 * @param {string} [defaultCurrency='PHP']
 * @returns {Price|null}
 */
export function parsePrice(text, defaultCurrency = 'PHP') {
  if (typeof text !== 'string') return null;
  const priceMatch = PRICE_RE.exec(text);
  const freeMatch = FREE_RE.exec(text);
  if (freeMatch && (!priceMatch || freeMatch.index < priceMatch.index)) {
    return { amount: 0, currency: defaultCurrency, raw: 'Free' };
  }
  if (!priceMatch) return null;

  const [whole, , , numberText] = priceMatch;
  const currency = priceMatch[1] ? SYMBOL_CURRENCY[priceMatch[1]] : priceMatch[2];
  const [intPart, decPart = ''] = numberText.replace(/,/g, '').split('.');
  const cents = Number(decPart.padEnd(2, '0'));
  const amount = Number(intPart) * 100 + cents;
  return { amount, currency, raw: whole.trim() };
}

/** True when the whole trimmed line is a price (or Free). */
function isPriceLine(line) {
  const p = parsePrice(line);
  return p !== null && p.raw === line;
}

/**
 * Parse one search-result card.
 * @param {{ href: string, text: string, img?: string|null }} card
 * @param {{ currency?: string }} [opts]
 * @returns {{ id: string, url: string, title: string, price: Price|null, location: string|null,
 *            image: string|null, label: null|'sold'|'pending' }|null} CardListing, or null
 */
export function parseCard({ href, text, img } = {}, { currency = 'PHP' } = {}) {
  const id = itemIdFromHref(href);
  if (!id) return null;

  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => l.toLowerCase() === 'sponsored')) return null;

  let label = null;
  const labelLines = lines.filter((l) => /^(sold|pending)$/i.test(l));
  if (labelLines.length > 0) label = labelLines[0].toLowerCase();

  let price = null;
  const rest = [];
  for (const line of lines) {
    if (/^(sold|pending)$/i.test(line)) continue;
    if (isPriceLine(line)) {
      // The first price line is the price; later ones (a struck-through old price) are dropped.
      if (price === null) price = parsePrice(line, currency);
      continue;
    }
    rest.push(line);
  }

  if (rest.length === 0) return null;
  return {
    id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title: rest[0],
    price,
    location: rest[1] ?? null,
    image: img || null,
    label,
  };
}

/** Trim a string; empty or non-string becomes null. */
function clean(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Parse a detail page from raw extracted strings.
 * @param {{ title?: string|null, priceText?: string|null, labelText?: string|null,
 *           description?: string|null, sellerName?: string|null,
 *           postedText?: string|null, condition?: string|null }} raw
 * @param {{ currency?: string }} [opts]
 * @returns {{ title: string|null, price: Price|null, label: null|'sold'|'pending',
 *            description: string|null, sellerName: string|null, postedText: string|null,
 *            condition: string|null }} Detail
 */
export function parseDetail(raw = {}, { currency = 'PHP' } = {}) {
  const labelText = (clean(raw.labelText) ?? '').toLowerCase();
  let label = null;
  if (labelText.includes('sold')) label = 'sold';
  else if (labelText.includes('pending')) label = 'pending';

  const priceText = clean(raw.priceText);
  return {
    title: clean(raw.title),
    price: priceText === null ? null : parsePrice(priceText, currency),
    label,
    description: clean(raw.description),
    sellerName: clean(raw.sellerName),
    postedText: clean(raw.postedText),
    condition: clean(raw.condition),
  };
}
