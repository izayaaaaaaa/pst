// `npm run watch -- "<query>" [--times N] [--every 30m] [--until 18:00] [...]`
// Runs a watch in the foreground: passes spaced out, alerts to the store and the desktop.
// Attach to Chrome first with `npm run chrome` (D-001). Stop with Ctrl+C.
import { attach } from './browser.js';
import { config } from './config.js';
import { Facebook } from './fb.js';
import { DailyBudget } from './guard.js';
import { parseArgs } from './watch/args.js';
import { runWatch } from './watch/runner.js';
import { WatchStore } from './watch/store.js';
import { alertsToNotifications, notify as showNotifications } from './alerts/notify.js';

const USAGE = `Usage: npm run watch -- "<query>" [options]
  --times N            passes to run (1-48; default 4, or derived from --until)
  --every 30m          time between passes (min 10m; default 30m)
  --until 18:00        stop after this time (HH:MM today/tomorrow, or ISO)
  --min-price N        whole units, e.g. 5000
  --max-price N        whole units
  --location SLUG      Marketplace location (default: MARKET_LOCATION or your profile's)
  --radius KM          search radius (default MARKET_RADIUS_KM)
  --days N             listed within the last N days
  --max-listings N     cards per pass, 1-100 (default 40)
  --details N          detail pages per pass, 0-20 (default 5)
  --alert "RULE"       alert rule, repeatable, e.g. --alert "drop>=2000 & keyword:\\"256 gb\\""
  --no-desktop         no OS notifications (alerts still show in the UI and console)
  -h, --help           show this help`;

const sleepInterruptible = (signal) => (ms) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  let spec;
  try {
    spec = parseArgs(argv, { config });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE.split('\n')[0]);
    return 2;
  }

  const store = new WatchStore(config.outputDir);
  let release;
  try {
    release = store.acquireLock();
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts >= 2) process.exit(130);
    console.log('\nStopping after the current step. Press Ctrl+C again to quit now.');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const daily = new DailyBudget({ dir: config.outputDir, max: config.maxDailyVisits });
  console.log('Open the local UI with: npm run ui');

  try {
    const watch = await runWatch(spec, {
      store,
      daily,
      attach: () => attach(),
      makeFacebook: (page, budget, dailyBudget) => new Facebook(page, budget, { daily: dailyBudget }),
      notify: (alerts, s) => showNotifications(alertsToNotifications(alerts, { query: s.query })),
      now: () => new Date(),
      sleep: sleepInterruptible(controller.signal),
      rand: Math.random,
      log: (line) => console.log(line),
      quiet: { start: config.quietStartHour, end: config.quietEndHour },
      signal: controller.signal,
    });
    console.log(
      `Watch ${watch.id} ${watch.status}: ${watch.passesDone}/${watch.passesTotal} passes.` +
        (watch.lastError ? ` Last error: ${watch.lastError}` : ''),
    );
    return watch.status === 'error' ? 1 : 0;
  } catch (err) {
    console.error(`Stopped: ${err.message}`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    release();
  }
}

process.exitCode = await main();
