// JSON store for watches (D-005). One folder per watch under <outputDir>/watches/<id>/.
// Whole files are written atomically (temp file, then rename). Events, passes and alerts
// are JSONL, appended one object per line.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ID_RE = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;
const LOCK_NAME = '.lock';

/**
 * Watch id: `${YYYYMMDD}-${HHmmss}-${slug}` in local time.
 * @param {string} query
 * @param {Date} [now]
 * @returns {string}
 */
export function createWatchId(query, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let slug = String(query ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!slug) slug = 'watch';
  return `${date}-${time}-${slug}`;
}

/** @param {unknown} id */
export function isValidWatchId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** Write `data` to `file` atomically: temp file, then rename. */
function writeAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Read a JSONL file. Skips blank lines and lines that don't parse (e.g. a partial last line). */
function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial or corrupt line: skip it
    }
  }
  return out;
}

function appendJsonl(file, items) {
  if (!items.length) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, items.map((item) => `${JSON.stringify(item)}\n`).join(''));
}

/** True if a process with this pid exists (EPERM means it exists but isn't ours). */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class WatchStore {
  /** @param {string} outputDir */
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.watchesDir = path.join(outputDir, 'watches');
  }

  /** Folder for a watch. Throws on an invalid id, so ids can't escape the watches folder. */
  #dir(id) {
    if (!isValidWatchId(id)) throw new Error('Invalid watch id');
    return path.join(this.watchesDir, id);
  }

  #file(id, name) {
    return path.join(this.#dir(id), name);
  }

  /** Create a watch folder and write its watch.json. Throws if the folder already exists. */
  create(watch) {
    const dir = this.#dir(watch.id);
    if (existsSync(dir)) throw new Error(`Watch ${watch.id} already exists.`);
    mkdirSync(dir, { recursive: true });
    this.writeWatch(watch);
  }

  /** @returns {object|null} the watch, or null if missing */
  readWatch(id) {
    return readJson(this.#file(id, 'watch.json'), null);
  }

  writeWatch(watch) {
    writeAtomic(this.#file(watch.id, 'watch.json'), JSON.stringify(watch, null, 2));
  }

  /** @returns {object} listings keyed by id, or {} if missing */
  readListings(id) {
    return readJson(this.#file(id, 'listings.json'), {});
  }

  writeListings(id, known) {
    writeAtomic(this.#file(id, 'listings.json'), JSON.stringify(known, null, 2));
  }

  /** @returns {object} alert state keyed by `ruleId:listingId`, or {} if missing */
  readAlertState(id) {
    return readJson(this.#file(id, 'alertState.json'), {});
  }

  writeAlertState(id, state) {
    writeAtomic(this.#file(id, 'alertState.json'), JSON.stringify(state, null, 2));
  }

  appendPass(id, pass) {
    appendJsonl(this.#file(id, 'passes.jsonl'), [pass]);
  }

  readPasses(id) {
    return readJsonl(this.#file(id, 'passes.jsonl'));
  }

  appendEvents(id, events) {
    appendJsonl(this.#file(id, 'events.jsonl'), events);
  }

  readEvents(id) {
    return readJsonl(this.#file(id, 'events.jsonl'));
  }

  appendAlerts(id, alerts) {
    appendJsonl(this.#file(id, 'alerts.jsonl'), alerts);
  }

  readAlerts(id) {
    return readJsonl(this.#file(id, 'alerts.jsonl'));
  }

  /** @returns {Set<string>} ids of alerts marked read for this watch */
  readReadIds(id) {
    const data = readJson(this.#file(id, 'alerts-read.json'), { readIds: [] });
    return new Set(Array.isArray(data.readIds) ? data.readIds : []);
  }

  /** Mark alert ids read (union with what's already read). Returns how many were new. */
  markRead(id, ids) {
    const readIds = this.readReadIds(id);
    let marked = 0;
    for (const alertId of ids) {
      if (readIds.has(alertId)) continue;
      readIds.add(alertId);
      marked += 1;
    }
    writeAtomic(this.#file(id, 'alerts-read.json'), JSON.stringify({ readIds: [...readIds] }, null, 2));
    return marked;
  }

  /** Ids of watches that have a watch.json, newest first. */
  listWatchIds() {
    if (!existsSync(this.watchesDir)) return [];
    return readdirSync(this.watchesDir)
      .filter((name) => isValidWatchId(name) && existsSync(path.join(this.watchesDir, name, 'watch.json')))
      .sort()
      .reverse();
  }

  /**
   * Take the single-watcher lock. Throws if another live process holds it.
   * A stale lock (dead pid) is replaced.
   * @returns {() => void} release, which removes the lock only if it still holds our pid
   */
  acquireLock() {
    mkdirSync(this.watchesDir, { recursive: true });
    const lockPath = path.join(this.watchesDir, LOCK_NAME);
    if (existsSync(lockPath)) {
      let held = null;
      try {
        held = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        held = null;
      }
      if (isAlive(held?.pid)) throw new Error(`Another watch is running (pid ${held.pid}).`);
      unlinkSync(lockPath);
    }
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { flag: 'wx' },
      );
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      throw new Error('Another watch is running.');
    }
    return () => {
      try {
        const held = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (held.pid === process.pid) unlinkSync(lockPath);
      } catch {
        // already gone or unreadable: nothing of ours to remove
      }
    };
  }
}
