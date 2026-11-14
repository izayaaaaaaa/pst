// Local UI server (D-006). Reads the watch store; its only write is alert read-marks.
// Binds 127.0.0.1 only and checks Host and Origin on every request, so other sites and
// LAN devices can't reach it. Config is loaded only when run directly, so importing this
// module (tests) never reads .env.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WatchStore, isValidWatchId } from './watch/store.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 10 * 1024;
const STATIC_NAME_RE = /^[a-z0-9_-]+\.(js|css|svg)$/;
const CONTENT_TYPES = {
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://*.fbcdn.net data:; style-src 'self'; script-src 'self'; connect-src 'self'",
};
const LISTING_STATUSES = ['active', 'pending', 'sold', 'missing'];

/**
 * @param {{ store: WatchStore, publicDir?: string }} opts
 * @returns {http.Server} not listening yet
 */
export function createServer({ store, publicDir = PUBLIC_DIR }) {
  const server = http.createServer((req, res) => {
    handle(req, res, { server, store, publicDir }).catch((err) => {
      console.error('UI request failed:', err);
      if (!res.headersSent) sendError(res, 500, 'Server error');
      else res.end();
    });
  });
  return server;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const sendJson = (res, status, body) => send(res, status, body);
const sendError = (res, status, error) => send(res, status, { error });

/** Routes in order. A path that matches with the wrong method gets 405. */
const ROUTES = [
  { method: 'GET', re: /^\/$/, run: serveIndex },
  { method: 'GET', re: /^\/static\/([^/]+)$/, run: serveStatic },
  { method: 'GET', re: /^\/api\/watches$/, run: listWatches },
  { method: 'GET', re: /^\/api\/watches\/([^/]+)$/, run: getWatch },
  { method: 'GET', re: /^\/api\/watches\/([^/]+)\/events$/, run: getEvents },
  { method: 'GET', re: /^\/api\/alerts$/, run: listAlerts },
  { method: 'POST', re: /^\/api\/alerts\/read$/, run: markRead },
];

async function handle(req, res, ctx) {
  const port = ctx.server.address()?.port;
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return sendError(res, 403, 'Bad host');
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  let found = null;
  let methodMismatch = false;
  for (const route of ROUTES) {
    const m = route.re.exec(url.pathname);
    if (!m) continue;
    if (route.method !== req.method) {
      methodMismatch = true;
      continue;
    }
    found = { route, params: m.slice(1) };
    break;
  }
  if (!found) {
    return methodMismatch ? sendError(res, 405, 'Method not allowed') : sendError(res, 404, 'Not found');
  }
  return found.route.run(ctx, req, res, url, found.params);
}

/** A watch id from the URL, or null if it isn't a valid id. */
function watchIdParam(raw) {
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isValidWatchId(id) ? id : null;
}

/** The watch if the id is valid and the watch exists, else null. */
function loadWatch(store, id) {
  if (!isValidWatchId(id)) return null;
  return store.readWatch(id);
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function serveIndex(ctx, req, res) {
  return serveFile(res, path.join(ctx.publicDir, 'index.html'), 'text/html; charset=utf-8');
}

async function serveFile(res, file, type) {
  let data;
  try {
    data = await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Not found');
    throw err;
  }
  return send(res, 200, data, type);
}

function serveStatic(ctx, req, res, url, [name]) {
  if (!STATIC_NAME_RE.test(name)) return sendError(res, 404, 'Not found');
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return serveFile(res, path.join(ctx.publicDir, name), CONTENT_TYPES[ext]);
}

function summarize(store, id, watch) {
  const listings = Object.values(store.readListings(id));
  const events = store.readEvents(id);
  const readIds = store.readReadIds(id);
  const alerts = store.readAlerts(id);
  const counts = { total: listings.length, active: 0, sold: 0, pending: 0, missing: 0, new: 0, priceDrops: 0 };
  for (const l of listings) {
    if (LISTING_STATUSES.includes(l.status)) counts[l.status] += 1;
  }
  for (const e of events) {
    if (e.type === 'new') counts.new += 1;
    else if (e.type === 'price_drop') counts.priceDrops += 1;
  }
  return {
    id,
    query: watch.query,
    status: watch.status,
    passesDone: watch.passesDone,
    passesTotal: watch.passesTotal,
    until: watch.until ?? null,
    nextPassAt: watch.nextPassAt ?? null,
    filters: watch.filters ?? null,
    searchArea: watch.searchArea ?? null,
    lastError: watch.lastError ?? null,
    counts,
    unreadAlerts: alerts.filter((a) => !readIds.has(a.id)).length,
  };
}

function listWatches(ctx, req, res) {
  const { store } = ctx;
  const out = [];
  for (const id of store.listWatchIds()) {
    const watch = store.readWatch(id);
    if (watch) out.push(summarize(store, id, watch));
  }
  return sendJson(res, 200, out);
}

function getWatch(ctx, req, res, url, [raw]) {
  const id = watchIdParam(raw);
  const watch = id && loadWatch(ctx.store, id);
  if (!watch) return sendError(res, 404, 'Unknown watch');
  const listings = Object.values(ctx.store.readListings(id)).sort(
    (a, b) => (a.firstSeen?.pass ?? 0) - (b.firstSeen?.pass ?? 0) || cmpStr(a.id, b.id),
  );
  return sendJson(res, 200, {
    watch,
    listings,
    passes: ctx.store.readPasses(id),
    detailsQueued: watch.detailsQueued ?? 0,
  });
}

function getEvents(ctx, req, res, url, [raw]) {
  const id = watchIdParam(raw);
  if (!id || !loadWatch(ctx.store, id)) return sendError(res, 404, 'Unknown watch');

  let sinceMs = null;
  const since = url.searchParams.get('since');
  if (since !== null) {
    sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) return sendError(res, 400, 'Bad since');
  }
  let limit = 200;
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam) || Number(limitParam) < 1) return sendError(res, 400, 'Bad limit');
    limit = Math.min(1000, Number(limitParam));
  }

  const events = ctx.store
    .readEvents(id)
    .filter((e) => sinceMs === null || Date.parse(e.at) > sinceMs)
    .reverse()
    .slice(0, limit);
  return sendJson(res, 200, events);
}

function listAlerts(ctx, req, res, url) {
  const { store } = ctx;
  const unreadOnly = url.searchParams.get('unread') === '1';
  const watchParam = url.searchParams.get('watch');
  let ids;
  if (watchParam !== null) {
    if (!loadWatch(store, watchParam)) return sendError(res, 404, 'Unknown watch');
    ids = [watchParam];
  } else {
    ids = store.listWatchIds();
  }

  const out = [];
  for (const id of ids) {
    const readIds = store.readReadIds(id);
    for (const alert of store.readAlerts(id)) {
      const read = readIds.has(alert.id);
      if (unreadOnly && read) continue;
      out.push({ ...alert, read });
    }
  }
  out.sort((a, b) => cmpStr(String(b.at ?? ''), String(a.at ?? '')));
  return sendJson(res, 200, out.slice(0, 500));
}

/** Read the request body up to MAX_BODY_BYTES. Resolves { tooBig, text }. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true; // keep draining so the response can be sent
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooBig, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ tooBig: true, text: '' }));
  });
}

async function markRead(ctx, req, res) {
  const { store, server } = ctx;
  const port = server.address()?.port;
  const origin = req.headers.origin;
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    await readBody(req);
    return sendError(res, 403, 'Bad origin');
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    await readBody(req);
    return sendError(res, 403, 'Bad content type');
  }

  const { tooBig, text } = await readBody(req);
  if (tooBig) return sendError(res, 400, 'Body too large');

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return sendError(res, 400, 'Bad JSON');
  }
  if (!body || typeof body !== 'object') return sendError(res, 400, 'Bad body');

  const id = body.watch;
  if (!loadWatch(store, id)) return sendError(res, 404, 'Unknown watch');

  let ids;
  if (body.all === true) {
    ids = store.readAlerts(id).map((a) => a.id);
  } else {
    if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      return sendError(res, 400, 'ids must be an array of strings');
    }
    const known = new Set(store.readAlerts(id).map((a) => a.id));
    ids = body.ids.filter((x) => known.has(x));
  }
  const marked = store.markRead(id, ids);
  return sendJson(res, 200, { ok: true, marked });
}

// Run directly (npm run ui): listen on the configured port. Config is loaded only here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const { config } = await import('./config.js');
    const store = new WatchStore(config.outputDir);
    const server = createServer({ store, publicDir: PUBLIC_DIR });
    server.listen(config.uiPort, '127.0.0.1', () => {
      console.log(`pst UI: http://127.0.0.1:${server.address().port}/`);
    });
  })();
}
