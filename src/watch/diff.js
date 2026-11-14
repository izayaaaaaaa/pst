// Pure diff and tracking of listings between passes. No I/O, no config imports.
// Inputs are never mutated: every change builds new objects and arrays.

const REACTIVATE_FROM = ['missing', 'sold', 'pending'];

/**
 * Apply an observation (price, title, label) to one tracked listing.
 * Shared by seen cards and detail pages.
 * @param {object} entry TrackedListing
 * @param {{ price: object|null, title: string|null, label: string|null }} obs
 * @param {{ pass: number, at: string }} ctx
 * @param {{ nullLabelIsBack: boolean }} opts
 * @returns {{ entry: object, events: object[] }}
 */
function applyObservation(entry, obs, ctx, { nullLabelIsBack }) {
  const events = [];
  const emit = (type, from, to) =>
    events.push({ at: ctx.at, pass: ctx.pass, type, listingId: entry.id, from, to });
  let next = entry;

  // Price
  const newAmount = obs.price?.amount ?? null;
  const oldAmount = next.price?.amount ?? null;
  if (newAmount !== null) {
    const point = { pass: ctx.pass, at: ctx.at, amount: newAmount };
    if (oldAmount === null) {
      next = { ...next, price: obs.price, priceHistory: [...next.priceHistory, point] };
    } else if (newAmount !== oldAmount && next.price.currency === obs.price.currency) {
      emit(newAmount < oldAmount ? 'price_drop' : 'price_up', oldAmount, newAmount);
      next = { ...next, price: obs.price, priceHistory: [...next.priceHistory, point] };
    }
  }

  // Title
  if (obs.title && obs.title !== next.title) {
    emit('title_change', next.title, obs.title);
    next = { ...next, title: obs.title };
  }

  // Status
  const label = obs.label ?? null;
  if (label === 'sold' && next.status !== 'sold') {
    emit('sold', next.status, 'sold');
    next = { ...next, status: 'sold' };
  } else if (label === 'pending' && next.status !== 'pending') {
    emit('pending', next.status, 'pending');
    next = { ...next, status: 'pending' };
  } else if (label === null && nullLabelIsBack && REACTIVATE_FROM.includes(next.status)) {
    emit('back', next.status, 'active');
    next = { ...next, status: 'active' };
  }

  return { entry: next, events };
}

/** Compare two strings for sorting. */
function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold one search pass into the tracked listings.
 * @param {Record<string, object>} known TrackedListing map keyed by id
 * @param {object[]} seen CardListing[] in page order
 * @param {{ pass: number, at: string, maxListings: number, cardsRead: number }} ctx
 * @returns {{ known: Record<string, object>, events: object[] }}
 */
export function diff(known, seen, ctx) {
  const next = { ...known };
  const events = [];
  const seenIds = new Set();

  seen.forEach((card, rank) => {
    if (!card || !card.id || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    const prev = known[card.id];

    if (!prev) {
      const status = card.label === 'sold' || card.label === 'pending' ? card.label : 'active';
      const amount = card.price?.amount ?? null;
      const entry = {
        id: card.id,
        url: card.url,
        title: card.title,
        image: card.image ?? null,
        location: card.location ?? null,
        price: card.price ?? null,
        priceHistory: amount !== null ? [{ pass: ctx.pass, at: ctx.at, amount }] : [],
        firstSeen: { pass: ctx.pass, at: ctx.at },
        lastSeen: { pass: ctx.pass, at: ctx.at },
        lastRank: rank,
        missedPasses: 0,
        status,
        detail: null,
      };
      next[card.id] = entry;
      if (ctx.pass !== 1) {
        events.push({ at: ctx.at, pass: ctx.pass, type: 'new', listingId: card.id, from: null, to: null });
      }
      return;
    }

    const updated = {
      ...prev,
      url: card.url,
      image: card.image ?? null,
      location: card.location ?? null,
      lastSeen: { pass: ctx.pass, at: ctx.at },
      lastRank: rank,
      missedPasses: 0,
    };
    const result = applyObservation(
      updated,
      { price: card.price ?? null, title: card.title ?? null, label: card.label ?? null },
      ctx,
      { nullLabelIsBack: true },
    );
    next[card.id] = result.entry;
    events.push(...result.events);
  });

  const notSeen = Object.keys(known)
    .filter((id) => !seenIds.has(id))
    .sort(byText);
  for (const id of notSeen) {
    const prev = known[id];
    if (prev.status !== 'active' && prev.status !== 'pending') continue;
    const countsAsMiss =
      ctx.cardsRead < ctx.maxListings || prev.lastRank < Math.floor(ctx.maxListings * 0.75);
    if (!countsAsMiss) continue;

    const missedPasses = prev.missedPasses + 1;
    if (missedPasses >= 2) {
      next[id] = { ...prev, missedPasses, status: 'missing' };
      events.push({ at: ctx.at, pass: ctx.pass, type: 'missing', listingId: id, from: prev.status, to: 'missing' });
    } else {
      next[id] = { ...prev, missedPasses };
    }
  }

  return { known: next, events };
}

/**
 * Attach a detail page to a tracked listing and apply its price, title and label.
 * @param {Record<string, object>} known
 * @param {string} id
 * @param {object} detail Detail
 * @param {{ pass: number, at: string }} ctx
 * @returns {{ known: Record<string, object>, events: object[] }}
 */
export function applyDetail(known, id, detail, ctx) {
  const prev = known[id];
  if (!prev) return { known, events: [] };

  const withDetail = {
    ...prev,
    detail: {
      description: detail.description ?? null,
      sellerName: detail.sellerName ?? null,
      postedText: detail.postedText ?? null,
      condition: detail.condition ?? null,
      at: ctx.at,
    },
  };
  const result = applyObservation(
    withDetail,
    { price: detail.price ?? null, title: detail.title ?? null, label: detail.label ?? null },
    ctx,
    { nullLabelIsBack: false },
  );
  return { known: { ...known, [id]: result.entry }, events: result.events };
}

/**
 * Ids still needing a detail page, in visiting order.
 * @param {Record<string, object>} known
 * @param {{ isPriority?: (listing: object) => boolean }} [opts]
 * @returns {string[]}
 */
export function detailQueue(known, { isPriority = () => false } = {}) {
  const items = Object.values(known)
    .filter((l) => l.detail === null && (l.status === 'active' || l.status === 'pending'))
    .map((l) => ({
      id: l.id,
      priority: isPriority(l) ? 0 : 1,
      amount: l.price?.amount ?? null,
      firstPass: l.firstSeen.pass,
    }));

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.amount !== b.amount) {
      if (a.amount === null) return 1;
      if (b.amount === null) return -1;
      return a.amount - b.amount;
    }
    if (a.firstPass !== b.firstPass) return a.firstPass - b.firstPass;
    return byText(a.id, b.id);
  });
  return items.map((i) => i.id);
}
