// Alert rules: parse the --alert text, decide if a listing matches, and work out which alerts fire this pass.
// Pure: no I/O, no config. Inputs are never mutated.

/**
 * @typedef {{ amount: number|null, currency: string|null, raw: string }} Price
 * @typedef {{ type: 'price', op: '<'|'<=', amount: number }
 *   | { type: 'drop', amount: number }
 *   | { type: 'drop', percent: number }
 *   | { type: 'new' }
 *   | { type: 'keyword', text: string, negate: boolean }} Clause
 * @typedef {{ id: string, text: string, clauses: Clause[] }} AlertRule
 */

const SYMBOLS = { PHP: '₱', USD: '$', EUR: '€', GBP: '£' };
const WHOLE_UNITS = /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;
const PERCENT = /^\d+(?:\.\d+)?$/;

/**
 * Lowercase, strip accents, collapse whitespace.
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Minor units to a display string: ₱24,500, $12.50, €3, XYZ 1,000. Null price → '?'.
 * @param {Price|{amount: number|null, currency: string|null}|null|undefined} price
 * @returns {string}
 */
export function formatMoney(price) {
  if (!price || price.amount == null) return '?';
  const minor = Math.round(price.amount);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = abs % 100;
  const num = `${neg ? '-' : ''}${whole}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
  const code = price.currency ? String(price.currency).toUpperCase() : null;
  if (!code) return num;
  if (SYMBOLS[code]) return `${neg ? '-' : ''}${SYMBOLS[code]}${num.replace(/^-/, '')}`;
  return `${code} ${num}`;
}

/**
 * Split on `&` outside double quotes.
 * @param {string} text
 * @returns {string[]}
 */
function splitClauses(text) {
  const parts = [];
  let cur = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === '&' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (inQuote) throw new Error('unclosed quote');
  parts.push(cur);
  return parts;
}

/**
 * @param {string} rest text after `keyword:` (already trimmed)
 * @param {string} clause the whole clause, for messages
 * @returns {string} normalized keyword text
 */
function parseKeywordText(rest, clause) {
  let inner = rest;
  if (rest.startsWith('"')) {
    if (rest.length < 2 || !rest.endsWith('"')) throw new Error(`unclosed quote in "${clause}"`);
    inner = rest.slice(1, -1);
  }
  if (inner.includes('"')) throw new Error(`stray quote in "${clause}"`);
  const text = normalizeText(inner);
  if (!text) throw new Error(`empty keyword in "${clause}"`);
  return text;
}

/**
 * Parse one clause (already split and trimmed).
 * @param {string} clause
 * @returns {Clause}
 */
function parseClause(clause) {
  if (!clause) throw new Error('empty clause');

  const price = /^price(<=|<)(.*)$/.exec(clause);
  if (price) {
    if (!WHOLE_UNITS.test(price[2])) throw new Error(`bad amount in "${clause}", write e.g. price<25000`);
    return { type: 'price', op: /** @type {'<'|'<='} */ (price[1]), amount: Number(price[2].replace(/,/g, '')) * 100 };
  }
  if (/^price\s*<=?/.test(clause)) {
    throw new Error(`bad price clause "${clause}", write it with no spaces, e.g. price<25000`);
  }

  if (clause === 'new') return { type: 'new' };

  if (clause.startsWith('drop>=')) {
    const rest = clause.slice('drop>='.length);
    if (rest.endsWith('%')) {
      const num = rest.slice(0, -1);
      if (!PERCENT.test(num)) throw new Error(`bad percent in "${clause}", write e.g. drop>=10%`);
      const percent = Number(num);
      if (!(percent > 0 && percent <= 100)) throw new Error(`percent must be above 0 and at most 100 in "${clause}"`);
      return { type: 'drop', percent };
    }
    if (!WHOLE_UNITS.test(rest)) throw new Error(`bad amount in "${clause}", write e.g. drop>=2500 or drop>=10%`);
    const units = Number(rest.replace(/,/g, ''));
    if (!(units > 0)) throw new Error(`drop amount must be above 0 in "${clause}"`);
    return { type: 'drop', amount: units * 100 };
  }
  if (clause.startsWith('drop') && !clause.startsWith('drop>=')) {
    throw new Error(`bad drop clause "${clause}", write e.g. drop>=2500 or drop>=10%`);
  }

  if (clause.startsWith('-keyword:')) {
    return { type: 'keyword', text: parseKeywordText(clause.slice('-keyword:'.length).trim(), clause), negate: true };
  }
  if (clause.startsWith('keyword:')) {
    return { type: 'keyword', text: parseKeywordText(clause.slice('keyword:'.length).trim(), clause), negate: false };
  }

  throw new Error(`unknown clause "${clause}"`);
}

/**
 * Parse one rule such as `price<25000 & keyword:"256 gb"`.
 * @param {string} text
 * @param {string} id
 * @returns {AlertRule}
 */
export function parseRule(text, id) {
  const src = String(text ?? '').trim();
  try {
    const clauses = splitClauses(src).map((c) => parseClause(c.trim()));
    return { id, text: src, clauses };
  } catch (err) {
    throw new Error(`Bad alert rule "${src}": ${err.message}`);
  }
}

/**
 * @param {string[]} texts
 * @returns {AlertRule[]} ids r1, r2, … in order
 */
export function parseRules(texts) {
  return texts.map((t, i) => parseRule(t, `r${i + 1}`));
}

/**
 * Check one clause against a listing.
 * @returns {{ ok: boolean, reason: string }}
 */
function checkClause(clause, listing, isNew) {
  const currency = listing.price?.currency ?? null;
  const amount = listing.price?.amount ?? null;

  switch (clause.type) {
    case 'price': {
      if (amount == null) return { ok: false, reason: '' };
      const ok = clause.op === '<' ? amount < clause.amount : amount <= clause.amount;
      const reason = `price ${formatMoney(listing.price)} ${clause.op} ${formatMoney({ amount: clause.amount, currency })}`;
      return { ok, reason };
    }
    case 'drop': {
      const first = listing.priceHistory?.[0]?.amount ?? null;
      if (first == null || amount == null || first <= 0) return { ok: false, reason: '' };
      const diff = first - amount;
      const pct = Math.floor((diff * 100) / first);
      const ok = 'amount' in clause ? diff >= clause.amount : (diff * 100) / first >= clause.percent;
      return { ok, reason: `down ${formatMoney({ amount: diff, currency })} (${pct}%) since first seen` };
    }
    case 'new':
      return { ok: isNew, reason: 'new' };
    case 'keyword': {
      const hay = normalizeText(`${listing.title ?? ''} ${listing.detail?.description ?? ''}`);
      const has = hay.includes(clause.text);
      if (clause.negate) return { ok: !has, reason: `no "${clause.text}"` };
      return { ok: has, reason: `has "${clause.text}"` };
    }
    default:
      return { ok: false, reason: '' };
  }
}

/**
 * Does a rule hold for a listing? Only active listings can match.
 * @param {AlertRule} rule
 * @param {object} listing TrackedListing (or anything with the same fields)
 * @param {{ isNew?: boolean }} [opts]
 * @returns {{ match: boolean, reason: string }}
 */
export function evaluate(rule, listing, { isNew = false } = {}) {
  if (listing.status !== 'active') return { match: false, reason: '' };
  const results = rule.clauses.map((c) => checkClause(c, listing, isNew));
  const match = results.every((r) => r.ok);
  if (!match) return { match: false, reason: '' };
  return { match: true, reason: results.map((r) => r.reason).join('; ') };
}

/**
 * Would this rule match a card as it is right now? Used to prioritise details.
 * @param {AlertRule} rule
 * @param {object} listing
 * @returns {boolean}
 */
export function cardMatches(rule, listing) {
  return evaluate(rule, listing, { isNew: true }).match;
}

/**
 * Work out which alerts fire this pass. Fires when a rule starts to match, or when the
 * price changes while it still matches.
 * @param {AlertRule[]} rules
 * @param {Record<string, object>} known listings by id
 * @param {Record<string, {matched: boolean, lastPrice: number|null}>} state alertState so far
 * @param {{ pass: number, at: string, watchId: string, newIds: Set<string>|string[] }} ctx
 * @returns {{ state: object, alerts: object[] }}
 */
export function fire(rules, known, state, { pass, at, watchId, newIds }) {
  const newSet = newIds instanceof Set ? newIds : new Set(newIds ?? []);
  const next = { ...state };
  const alerts = [];
  const ids = Object.keys(known).sort();

  for (const rule of rules) {
    for (const id of ids) {
      const listing = known[id];
      const key = `${rule.id}:${id}`;
      const prev = state[key];
      const amount = listing.price?.amount ?? null;
      const currency = listing.price?.currency ?? null;
      const r = evaluate(rule, listing, { isNew: newSet.has(id) });

      const reFire = r.match && prev?.matched && prev.lastPrice !== amount;
      const firstFire = r.match && !prev?.matched;
      next[key] = { matched: r.match, lastPrice: amount };
      if (!firstFire && !reFire) continue;

      let prevPrice = null;
      let reason = r.reason;
      if (reFire) {
        prevPrice = { amount: prev.lastPrice, currency };
        reason = `${r.reason}; was ${formatMoney(prevPrice)}`;
      } else {
        const h = listing.priceHistory ?? [];
        const before = h.length >= 2 ? h[h.length - 2].amount : null;
        if (before != null) prevPrice = { amount: before, currency };
      }

      alerts.push({
        id: `${watchId}:${pass}:${rule.id}:${id}`,
        at,
        pass,
        watchId,
        ruleId: rule.id,
        ruleText: rule.text,
        listingId: id,
        title: listing.title ?? null,
        url: listing.url ?? null,
        location: listing.location ?? null,
        price: listing.price ?? null,
        prevPrice,
        reason,
      });
    }
  }
  return { state: next, alerts };
}
