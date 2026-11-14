// `npm run market -- "<query>" [--raw] [...]`: one search pass, printed to the terminal.
// Writes nothing to output/watches. Used for the live selector-tuning step (D-009).
import { attach } from './browser.js';
import { config } from './config.js';
import { Facebook, marketplaceSearchUrl } from './fb.js';
import { Budget, DailyBudget } from './guard.js';
import { inQuietHours } from './human.js';
import { parseArgs } from './watch/args.js';
import { detailsAllowed } from './watch/runner.js';
import { parseCard, parseDetail as parseDetailRaw } from './market/parse.js';
import { formatMoney } from './alerts/rules.js';

const USAGE = `Usage: npm run market -- "<query>" [--raw] [--details N] [--min-price N] [--max-price N] [--location SLUG] [--radius KM] [--days N] [--max-listings N]
  --raw   also print the raw card text of the first 3 cards (for tuning selectors)
  Watch-only options (--times, --until, --every, --alert, --no-desktop) are ignored here.`;

const IGNORED = new Set(['times', 'until', 'every']);

/** Drop the watch-only options (with their values) and --raw, so the shared parser accepts the rest. */
function marketArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : null;
    if (name === 'raw') continue;
    if (name && IGNORED.has(name)) {
      if (!a.includes('=')) i += 1; // skip its value
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const raw = argv.includes('--raw');

  let spec;
  try {
    spec = parseArgs(marketArgv(argv), { config });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE.split('\n')[0]);
    return 2;
  }
  if (!argv.some((a) => a === '--details' || a.startsWith('--details='))) spec.detailsPerPass = 1;

  if (inQuietHours()) {
    console.log(`Quiet hours (${config.quietStartHour}:00-${config.quietEndHour}:00). Not running.`);
    return 0;
  }

  const daily = new DailyBudget({ dir: config.outputDir, max: config.maxDailyVisits });
  if (daily.left() < 1) {
    console.error('No visits left today.');
    return 1;
  }

  const url = marketplaceSearchUrl(spec.query, spec.filters);
  console.log(`Search URL: ${url}`);

  const { page, detach } = await attach();
  try {
    const fb = new Facebook(page, new Budget(1 + spec.detailsPerPass), daily);
    await fb.marketplaceSearch(spec.query, spec.filters);
    console.log(`searchArea: ${(await fb.readSearchArea()) ?? '(not found)'}`);

    const raws = await fb.readListingCards(spec.maxListings);
    const cards = raws.map((r) => parseCard(r, { currency: spec.currency })).filter(Boolean);
    console.log(`Cards: ${raws.length} read, ${cards.length} parsed.`);
    for (const c of cards) {
      console.log(`${formatMoney(c.price)} · ${c.title} · ${c.location ?? '-'} · ${c.id}`);
    }

    if (raw) {
      raws.slice(0, 3).forEach((r, i) => console.log(`--- raw card ${i + 1} ---\n${r.text}\n`));
    }

    const k = detailsAllowed({
      k: spec.detailsPerPass,
      queued: cards.length,
      left: daily.left(),
      searchesRemaining: 0,
    });
    for (const card of cards.slice(0, k)) {
      const detail = parseDetailRaw(await fb.readListingDetail(card.id), { currency: spec.currency });
      console.log(`\nDetail ${card.id}:`);
      console.log(JSON.stringify(detail, null, 2));
    }
    return 0;
  } catch (err) {
    console.error(`Stopped: ${err.message}`);
    return 1;
  } finally {
    await detach();
  }
}

process.exitCode = await main();
