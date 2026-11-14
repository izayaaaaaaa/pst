// pst local UI: watches, one watch, alerts. Plain DOM only: createElement, textContent and
// setAttribute. Listing titles, sellers and text come from Facebook, so never use the HTML-string setter.

const POLL_MS = 15000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#8884"/></svg>',
  );
const LISTING_STATUS_FILTERS = ['all', 'active', 'pending', 'new', 'dropped', 'sold', 'missing', 'alerted'];

const app = document.getElementById('app');
const unreadBadge = document.getElementById('unread-badge');

// ---------- DOM helpers ----------

/**
 * Build an element. Keys: `class`, `text`, `on<event>` (function), anything else is an
 * attribute (`true` → empty attribute, `false`/null/undefined → omitted). Children may be
 * nodes, strings, numbers, nested arrays; null/undefined/false are skipped.
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function errorBox() {
  return el('p', { class: 'error', hidden: true });
}

function setError(box, message) {
  box.textContent = message ?? '';
  box.hidden = !message;
}

function badge(text, kind = text) {
  return el('span', { class: `badge badge-${kind}` }, text);
}

// ---------- API ----------

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---------- formatting ----------

/** Minor units (centavos) to money text. Whole amounts have no decimals. */
function money(minor, currency) {
  if (minor === null || minor === undefined) return '?';
  const value = minor / 100;
  const whole = Number.isInteger(value);
  const digits = { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 };
  if (!currency) return value.toLocaleString('en-PH', digits);
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency, ...digits }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en-PH', digits)}`;
  }
}

function priceText(price) {
  if (!price) return '—';
  if (price.amount === 0) return 'Free';
  if (price.amount === null || price.amount === undefined) return price.raw || '—';
  return money(price.amount, price.currency);
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function clock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function countdown(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Listing URLs come from Facebook data: only https facebook.com links are used. */
function safeListingUrl(url) {
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && (u.hostname === 'www.facebook.com' || u.hostname === 'facebook.com');
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

/** Only https images on fbcdn.net (matches the CSP); anything else shows the placeholder. */
function safeImageUrl(url) {
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && (u.hostname === 'fbcdn.net' || u.hostname.endsWith('.fbcdn.net'));
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

function thumb(src) {
  const img = el('img', {
    class: 'thumb',
    alt: '',
    width: 56,
    height: 56,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
  });
  img.src = safeImageUrl(src) ?? PLACEHOLDER;
  img.onerror = () => {
    img.onerror = null;
    img.src = PLACEHOLDER;
  };
  return img;
}

/** Inline SVG price sparkline. `amounts` are minor units, oldest first. */
function sparkline(amounts) {
  const W = 80;
  const H = 24;
  const P = 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price history, ${amounts.length} points`);

  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const span = max - min || 1;
  const n = amounts.length;
  const points = amounts
    .map((a, i) => {
      const x = n === 1 ? W / 2 : P + ((W - 2 * P) * i) / (n - 1);
      const y = H - P - ((H - 2 * P) * (a - min)) / span;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('class', 'spark-line');
  line.setAttribute('points', points);
  svg.append(line);
  return svg;
}

// ---------- shared state ----------

let current = null; // { key, root, refresh }
let busy = false;

async function refreshBadge() {
  try {
    const unread = await api('/api/alerts?unread=1');
    const n = unread.length;
    unreadBadge.textContent = n ? String(n) : '';
    unreadBadge.hidden = n === 0;
    document.title = n ? `(${n}) pst` : 'pst';
  } catch {
    // keep the last known badge
  }
}

// ---------- watches list ----------

function watchesView() {
  const err = errorBox();
  const host = el('div');
  const root = el('section', {}, el('h1', {}, 'Watches'), err, host);

  async function refresh() {
    try {
      const watches = await api('/api/watches');
      host.replaceChildren(watches.length ? watchesTable(watches) : el('p', { class: 'muted' }, 'No watches yet. Start one with npm run watch.'));
      setError(err, '');
    } catch (e) {
      setError(err, e.message);
    }
  }

  return { key: 'watches', root, refresh };
}

function watchesTable(watches) {
  const heads = ['Query', 'Status', 'Passes', 'Until', 'Next pass', 'Active', 'Sold', 'Pending', 'Missing', 'New', 'Drops', 'Unread'];
  const rows = watches.map((w) => {
    const c = w.counts ?? {};
    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el('a', { href: `#/watch/${encodeURIComponent(w.id)}` }, w.query),
        w.lastError ? el('div', { class: 'muted' }, w.lastError) : null,
      ),
      el('td', {}, badge(w.status)),
      el('td', { class: 'num' }, `${w.passesDone}/${w.passesTotal}`),
      el('td', { class: 'num' }, w.until ? clock(w.until) : '—'),
      el('td', { class: 'num' }, w.status === 'running' ? countdown(w.nextPassAt) : '—'),
      el('td', { class: 'num' }, c.active ?? 0),
      el('td', { class: 'num' }, c.sold ?? 0),
      el('td', { class: 'num' }, c.pending ?? 0),
      el('td', { class: 'num' }, c.missing ?? 0),
      el('td', { class: 'num' }, c.new ?? 0),
      el('td', { class: 'num' }, c.priceDrops ?? 0),
      el('td', { class: 'num' }, w.unreadAlerts ? badge(String(w.unreadAlerts), 'alert') : '0'),
    );
  });
  return el(
    'div',
    { class: 'table-wrap' },
    el('table', {}, el('thead', {}, el('tr', {}, heads.map((h) => el('th', { class: /^(Passes|Until|Next pass|Active|Sold|Pending|Missing|New|Drops|Unread)$/.test(h) ? 'num' : undefined }, h)))), el('tbody', {}, rows)),
  );
}

// ---------- one watch ----------

const SORTS = {
  newest: (a, b) =>
    (b.firstSeen?.pass ?? 0) - (a.firstSeen?.pass ?? 0) || cmpStr(b.firstSeen?.at ?? '', a.firstSeen?.at ?? ''),
  price: (a, b) => nullsLast(a.price?.amount ?? null, b.price?.amount ?? null),
  drop: (a, b) => nullsLast(priceChange(a), priceChange(b)),
};

function nullsLast(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Current amount minus the first seen amount (minor units), or null if unknown or unchanged. */
function priceChange(listing) {
  const first = listing.priceHistory?.[0]?.amount ?? null;
  const now = listing.price?.amount ?? null;
  if (first === null || now === null || first === now) return null;
  return now - first;
}

/** Whole-unit text to minor units, or null when empty or not a number. */
function toMinor(text) {
  if (!text || !text.trim()) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function watchView(id) {
  const filters = { sort: 'newest', status: 'all', min: '', max: '' };
  let data = null;

  const err = errorBox();
  const header = el('div', { class: 'panel' });
  const tableHost = el('div', { class: 'table-wrap' });
  const timelineHost = el('div');
  const passHost = el('div');

  const sortSel = el(
    'select',
    {},
    el('option', { value: 'newest' }, 'Newest'),
    el('option', { value: 'price' }, 'Price'),
    el('option', { value: 'drop' }, 'Biggest drop'),
  );
  const statusSel = el(
    'select',
    {},
    LISTING_STATUS_FILTERS.map((s) =>
      el('option', { value: s }, { all: 'All', new: 'New this pass', dropped: 'Dropped', alerted: 'Alerted' }[s] ?? s),
    ),
  );
  const minInput = el('input', { type: 'number', min: '0', step: '1', placeholder: 'min' });
  const maxInput = el('input', { type: 'number', min: '0', step: '1', placeholder: 'max' });
  sortSel.addEventListener('change', () => {
    filters.sort = sortSel.value;
    renderTable();
  });
  statusSel.addEventListener('change', () => {
    filters.status = statusSel.value;
    renderTable();
  });
  minInput.addEventListener('input', () => {
    filters.min = minInput.value;
    renderTable();
  });
  maxInput.addEventListener('input', () => {
    filters.max = maxInput.value;
    renderTable();
  });

  const controls = el(
    'div',
    { class: 'controls' },
    el('label', {}, 'Sort', sortSel),
    el('label', {}, 'Show', statusSel),
    el('label', {}, 'Min price', minInput),
    el('label', {}, 'Max price', maxInput),
  );

  const root = el(
    'section',
    {},
    el('p', {}, el('a', { href: '#/' }, '← All watches')),
    err,
    header,
    controls,
    tableHost,
    el('h2', {}, 'Events'),
    timelineHost,
    el('h2', {}, 'Passes'),
    passHost,
  );

  function renderHeader(detail) {
    const w = detail.watch;
    // replaceChildren stringifies null, so filter the optional children out.
    header.replaceChildren(
      ...[
        el('h1', {}, w.query),
        el(
          'div',
          { class: 'meta' },
          el('span', {}, el('b', {}, 'Status'), badge(w.status)),
          el('span', {}, el('b', {}, 'Passes'), `${w.passesDone}/${w.passesTotal}`),
          w.until ? el('span', {}, el('b', {}, 'Until'), clock(w.until)) : null,
          w.status === 'running' ? el('span', {}, el('b', {}, 'Next pass'), countdown(w.nextPassAt)) : null,
          el('span', {}, el('b', {}, 'Details queued'), String(detail.detailsQueued ?? 0)),
          el(
            'span',
            {},
            el('b', {}, 'Search area'),
            w.searchArea ? w.searchArea : badge('not read', 'warn'),
          ),
        ),
        (w.alerts ?? []).length
          ? el('div', {}, el('b', { class: 'muted' }, 'Rules: '), w.alerts.map((r) => el('span', { class: 'chip' }, r.text)))
          : null,
        w.lastError ? el('p', { class: 'notice' }, `Last error: ${w.lastError}`) : null,
      ].filter(Boolean),
    );
  }

  function renderTable() {
    if (!data) return;
    const listings = data.listings;
    const latest = Math.max(0, ...data.passes.map((p) => p.n ?? 0));
    const alerted = new Set(data.alerts.map((a) => a.listingId));
    const min = toMinor(filters.min);
    const max = toMinor(filters.max);

    const rows = listings
      .filter((l) => {
        if (filters.status === 'new' && l.firstSeen?.pass !== latest) return false;
        if (filters.status === 'dropped') {
          const c = priceChange(l);
          if (c === null || c >= 0) return false;
        }
        if (filters.status === 'alerted' && !alerted.has(l.id)) return false;
        if (!['all', 'new', 'dropped', 'alerted'].includes(filters.status) && l.status !== filters.status) return false;
        const amount = l.price?.amount ?? null;
        if (min !== null && (amount === null || amount < min)) return false;
        if (max !== null && (amount === null || amount > max)) return false;
        return true;
      })
      .sort(SORTS[filters.sort] ?? SORTS.newest);

    const heads = [
      ['Photo'],
      ['Title'],
      ['Price', true],
      ['Since first seen', true],
      ['History'],
      ['Status'],
      ['Alert'],
      ['Location'],
      ['First seen'],
      ['Last seen'],
    ];
    tableHost.replaceChildren(
      rows.length
        ? el(
            'table',
            {},
            el('thead', {}, el('tr', {}, heads.map(([h, num]) => el('th', { class: num ? 'num' : undefined }, h)))),
            el('tbody', {}, rows.map((l) => listingRow(l, alerted))),
          )
        : el('p', { class: 'muted' }, 'No listings match these filters.'),
    );
  }

  function renderTimeline() {
    const byId = new Map(data.listings.map((l) => [l.id, l]));
    const groups = [];
    let cur = null;
    for (const e of data.events) {
      if (!cur || cur.pass !== e.pass) {
        cur = { pass: e.pass, items: [] };
        groups.push(cur);
      }
      cur.items.push(`${clock(e.at)}  ${eventText(e, byId.get(e.listingId))}`);
    }
    timelineHost.replaceChildren(
      ...(groups.length
        ? groups.map((g) =>
            el('div', { class: 'event-group' }, el('h3', {}, `Pass ${g.pass}`), el('ul', {}, g.items.map((t) => el('li', {}, t)))),
          )
        : [el('p', { class: 'muted' }, 'No events yet.')]),
    );
  }

  function renderPasses() {
    const passes = [...data.passes].reverse();
    passHost.replaceChildren(
      passes.length
        ? el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  ['Pass', 'Started', 'Cards', 'Details', 'Visits', 'Result'].map((h) =>
                    el('th', { class: ['Cards', 'Details', 'Visits'].includes(h) ? 'num' : undefined }, h),
                  ),
                ),
              ),
              el(
                'tbody',
                {},
                passes.map((p) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, p.n),
                    el('td', {}, when(p.startedAt)),
                    el('td', { class: 'num' }, p.cardsRead ?? '—'),
                    el('td', { class: 'num' }, p.detailsOpened ?? '—'),
                    el('td', { class: 'num' }, p.visits ?? '—'),
                    el('td', {}, p.ok ? badge('ok', 'active') : el('span', { class: 'error' }, p.error || 'failed')),
                  ),
                ),
              ),
            ),
          )
        : el('p', { class: 'muted' }, 'No passes yet.'),
    );
  }

  async function refresh() {
    try {
      const [detail, events, alerts] = await Promise.all([
        api(`/api/watches/${encodeURIComponent(id)}`),
        api(`/api/watches/${encodeURIComponent(id)}/events?limit=1000`),
        api(`/api/alerts?watch=${encodeURIComponent(id)}`),
      ]);
      data = {
        listings: detail.listings,
        passes: detail.passes,
        detailsQueued: detail.detailsQueued,
        watch: detail.watch,
        events,
        alerts,
      };
      setError(err, '');
      renderHeader(data);
      renderTable();
      renderTimeline();
      renderPasses();
    } catch (e) {
      setError(err, e.message);
    }
  }

  return { key: `watch:${id}`, root, refresh };
}

function listingRow(l, alerted) {
  const url = safeListingUrl(l.url);
  const titleText = l.title || '(no title)';
  const title = url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, titleText) : titleText;
  const change = priceChange(l);
  const history = (l.priceHistory ?? []).map((p) => p.amount).filter((a) => typeof a === 'number');
  return el(
    'tr',
    {},
    el('td', {}, thumb(l.image)),
    el('td', {}, title),
    el('td', { class: 'num' }, priceText(l.price)),
    el(
      'td',
      { class: 'num' },
      change === null
        ? ''
        : el(
            'span',
            { class: change < 0 ? 'down' : 'up' },
            `${change < 0 ? '−' : '+'}${money(Math.abs(change), l.price?.currency)}`,
          ),
    ),
    el('td', {}, history.length >= 2 ? sparkline(history) : ''),
    el('td', {}, badge(l.status)),
    el('td', {}, alerted.has(l.id) ? badge('alerted', 'alert') : ''),
    el('td', {}, l.location || '—'),
    el('td', {}, when(l.firstSeen?.at)),
    el('td', {}, when(l.lastSeen?.at)),
  );
}

function eventText(e, listing) {
  const title = listing?.title || e.listingId;
  const currency = listing?.price?.currency ?? null;
  switch (e.type) {
    case 'new':
      return `New: ${title}`;
    case 'price_drop':
      return `${money(e.from - e.to, currency)} drop: ${title}`;
    case 'price_up':
      return `${money(e.to - e.from, currency)} rise: ${title}`;
    case 'title_change':
      return `Title changed: "${e.from}" → "${e.to}"`;
    case 'sold':
      return `Sold: ${title}`;
    case 'pending':
      return `Pending: ${title}`;
    case 'missing':
      return `Missing: ${title}`;
    case 'back':
      return `Back (${e.from} → ${e.to}): ${title}`;
    default:
      return `${e.type}: ${title}`;
  }
}

// ---------- alerts ----------

function alertsView() {
  const err = errorBox();
  const host = el('div');
  const root = el('section', {}, el('h1', {}, 'Alerts'), err, host);

  /** Run a write, then reload the list. Errors show in the view. */
  async function run(action) {
    try {
      await action();
      setError(err, '');
    } catch (e) {
      setError(err, e.message);
    }
    await refresh();
    await refreshBadge();
  }

  async function refresh() {
    try {
      const [alerts, watches] = await Promise.all([api('/api/alerts'), api('/api/watches')]);
      const queryOf = new Map(watches.map((w) => [w.id, w.query]));
      const groups = new Map();
      for (const a of alerts) {
        if (!groups.has(a.watchId)) groups.set(a.watchId, []);
        groups.get(a.watchId).push(a);
      }
      host.replaceChildren(
        ...(groups.size
          ? [...groups].map(([watchId, list]) => alertGroup(watchId, queryOf.get(watchId) ?? watchId, list, run))
          : [el('p', { class: 'muted' }, 'No alerts yet.')]),
      );
      setError(err, '');
    } catch (e) {
      setError(err, e.message);
    }
  }

  return { key: 'alerts', root, refresh };
}

function alertGroup(watchId, query, list, run) {
  const unread = list.filter((a) => !a.read).length;
  return el(
    'div',
    { class: 'panel alert-group' },
    el(
      'header',
      {},
      el('h2', {}, query),
      unread
        ? el(
            'button',
            {
              type: 'button',
              onclick: () => run(() => markRead({ watch: watchId, all: true })),
            },
            `Mark all read (${unread})`,
          )
        : el('span', { class: 'muted' }, 'All read'),
    ),
    list.map((a) => alertRow(a, run)),
  );
}

function alertRow(a, run) {
  const url = safeListingUrl(a.url);
  const titleText = a.title || '(no title)';
  const title = url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, titleText) : titleText;
  const was = a.prevPrice ? ` (was ${priceText(a.prevPrice)})` : '';
  const place = a.location ? ` · ${a.location}` : '';
  return el(
    'div',
    { class: a.read ? 'alert-row' : 'alert-row unread' },
    el('div', {}, el('strong', {}, a.ruleText), ' · ', title),
    el(
      'div',
      { class: 'act' },
      a.read
        ? el('span', { class: 'muted' }, 'Read')
        : el('button', { type: 'button', onclick: () => run(() => markRead({ watch: a.watchId, ids: [a.id] })) }, 'Mark read'),
    ),
    el('div', { class: 'when' }, `${when(a.at)} · ${priceText(a.price)}${was}${place}`),
    el('div', { class: 'reason' }, a.reason ?? ''),
  );
}

async function markRead(body) {
  await api('/api/alerts/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------- routing and polling ----------

function parseHash() {
  const hash = location.hash.replace(/^#/, '');
  const m = /^\/watch\/([^/]+)$/.exec(hash);
  if (m) {
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw text; the server answers 404
    }
    return { view: 'watch', id };
  }
  if (hash === '/alerts') return { view: 'alerts' };
  return { view: 'watches' };
}

async function route() {
  const { view, id } = parseHash();
  const key = view === 'watch' ? `watch:${id}` : view;
  if (!current || current.key !== key) {
    app.replaceChildren();
    current = view === 'watch' ? watchView(id) : view === 'alerts' ? alertsView() : watchesView();
    app.append(current.root);
  }
  await current.refresh();
  await refreshBadge();
}

async function tick() {
  if (busy || document.visibilityState !== 'visible' || !current) return;
  busy = true;
  try {
    await current.refresh();
    await refreshBadge();
  } finally {
    busy = false;
  }
}

window.addEventListener('hashchange', () => {
  route();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
});
setInterval(tick, POLL_MS);
route();
