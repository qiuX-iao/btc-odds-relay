#!/usr/bin/env node
/**
 * Fetch PER-WINDOW CONTRACT PRICES from Polymarket's public API and write the CSV
 * that `--odds csv` consumes.
 *
 * WHY THIS EXISTS
 *   `--odds fair` enters every window at 0.50, so PnL is a pure function of
 *   directional accuracy. To measure whether the bot beats the *market* you need
 *   the price the contract actually traded at, one row per window. That is the one
 *   input this project cannot generate for itself: a model that prices its own
 *   contracts would always look profitable.
 *
 * WHERE THE NUMBERS COME FROM
 *   Polymarket publishes 5m/15m "Bitcoin Up or Down" markets settled on the
 *   Chainlink BTC/USD data stream -- the same resolution source the rules name.
 *   Both endpoints used here are PUBLIC and need no key, no account, no signup:
 *
 *     Gamma (metadata)     GET /markets?slug=btc-updown-15m-<windowStartEpochSec>
 *                          -> .clobTokenIds (JSON-encoded array, one per outcome)
 *     CLOB (price history) GET /prices-history?market=<tokenId>&startTs=&endTs=&fidelity=
 *                          -> { history: [{ t: <unix sec>, p: <0..1 probability> }] }
 *
 *   The slug's number is the window's START instant, which is exactly the
 *   `windowStart` column this project matches on -- the join key is carried by the
 *   source itself rather than reconstructed here.
 *
 * ENTRY-PRICE CLAIM, STATED PRECISELY
 *   A row's `upPrice` is the FIRST quoted price at or after the window open: the
 *   price visible when committing at the open (`--decision open`, the default).
 *   Price history is sampled in whole minutes, so that sample can land up to
 *   `fidelity` minutes late; the actual instant and lag are written to the CSV
 *   (`entryAt`, `entryLagSec`) and summarised at the end. Rows later than
 *   `--max-entry-lag` are still written but counted, so a file that is "60%
 *   covered, and half of it is late" cannot masquerade as a clean one.
 *
 * FAILURE MODES ARE LOUD
 *   Reasons a window has no price are counted separately (no-market / no-tokens /
 *   no-up-outcome / no-history / bad-price) and printed. Zero usable rows exits
 *   non-zero and writes NOTHING, rather than leaving an empty-but-plausible CSV
 *   for someone to find later. Any transport failure aborts the whole run for the
 *   same reason: a truncated file reads as "the market was only open sometimes".
 *
 * THE PARSING IS TESTED, THE FETCH IS NOT
 *   Everything that decides what a row means lives in `src/core/polymarket.mjs`
 *   and is covered by `tests/polymarket.test.mjs`. The HTTP calls below are not
 *   covered by any test -- they need a network that can reach Polymarket. Run
 *   `--probe` first and read the raw JSON before trusting a batch.
 *
 * USAGE
 *   node tools/fetch-polymarket-odds.mjs --probe
 *   node tools/fetch-polymarket-odds.mjs --from 2026-08-28 --to 2026-09-18 \
 *        --window 15m --out data/polymarket-odds.csv
 *
 * THEN, ALWAYS:
 *   node src/cli.mjs odds-check --odds-file data/polymarket-odds.csv --file <candles>.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseInterval, toEpochMs } from '../src/util/time.mjs';
import { priceIsUsable } from '../src/core/odds.mjs';
import { pickEntryPoint, slugFor, toOddsCsv, upTokenIdOf, windowStartsBetween } from '../src/core/polymarket.mjs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { concurrency: '4', fidelity: '1', 'max-entry-lag': '120' };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--probe') {
    opt.probe = true;
    continue;
  }
  if (a === '--help' || a === '-h') {
    opt.help = true;
    continue;
  }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      console.error(`missing value for ${a}`);
      process.exit(2);
    }
    opt[key] = val;
    i += 1;
    continue;
  }
  console.error(`unexpected argument: ${a}`);
  process.exit(2);
}

if (opt.help) {
  console.log(
    [
      'node tools/fetch-polymarket-odds.mjs [options]',
      '',
      '  --from <ISO|epoch>      first window start to fetch (required)',
      '  --to   <ISO|epoch>      end of the range; the last window must close inside it (required)',
      '  --window <15m|5m>       window length (default 15m)',
      '  --out <path>            output CSV (default data/polymarket-odds.csv)',
      '  --slug-prefix <s>       market slug prefix (default btc-updown-<window>)',
      '  --fidelity <minutes>    price-history sampling (default 1)',
      '  --max-entry-lag <sec>   samples later than this are counted as late (default 120)',
      '  --concurrency <n>       parallel requests (default 4)',
      '  --probe                 fetch ONE window, dump raw JSON, write nothing',
    ].join('\n'),
  );
  process.exit(0);
}

const windowMs = parseInterval(opt.window ?? '15m');
const fidelity = Number(opt.fidelity);
const maxEntryLag = Number(opt['max-entry-lag']);
const slugPrefix = opt['slug-prefix'] ?? `btc-updown-${opt.window ?? '15m'}`;
const outPath = path.resolve(process.cwd(), opt.out ?? 'data/polymarket-odds.csv');
const winSec = windowMs / 1000;

// ---------------------------------------------------------------------------
// http (untested by design -- see the header)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { tries = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        // 404 is an answer here (no such market), not a transport problem.
        return { status: res.status, json: null };
      }
      return { status: res.status, json: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const code = lastErr?.code ?? lastErr?.name ?? 'ERROR';
  throw new Error(`${code}: ${lastErr?.message ?? 'request failed'} (${url})`);
}

// ---------------------------------------------------------------------------
// window list
// ---------------------------------------------------------------------------
const fromMs = toEpochMs(opt.from);
const toMs = toEpochMs(opt.to);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
  console.error('--from and --to are required, and must be ISO 8601 or epoch ms');
  process.exit(2);
}
if (toMs <= fromMs) {
  console.error('--to must be after --from');
  process.exit(2);
}

const starts = windowStartsBetween(fromMs, toMs, windowMs);
if (starts.length === 0) {
  console.error('no whole windows fit in that range; widen --from/--to');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// one window -> a row, or a counted reason
// ---------------------------------------------------------------------------
async function fetchOne(startMs) {
  const epochSec = Math.floor(startMs / 1000);
  const slug = slugFor(startMs, slugPrefix);
  const fail = (reason, detail = '') => ({ startMs, reason, detail });

  const mk = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const market = Array.isArray(mk.json) ? mk.json[0] : null;
  if (!market) return fail('no-market', `gamma HTTP ${mk.status}`);

  const up = upTokenIdOf(market);
  if (!up.tokenId) return fail('no-up-token', up.error);

  const qs = new URLSearchParams({
    market: up.tokenId,
    startTs: String(epochSec),
    endTs: String(epochSec + winSec),
    fidelity: String(fidelity),
  });
  const hist = await getJson(`${CLOB}/prices-history?${qs.toString()}`);
  const points = hist.json?.history;
  if (!Array.isArray(points) || points.length === 0) {
    return fail('no-history', `clob HTTP ${hist.status}`);
  }

  const entry = pickEntryPoint(points, startMs);
  if (!entry) return fail('bad-sample', `${points.length} point(s), none numeric`);
  if (!priceIsUsable(entry.upPrice)) return fail('bad-price', `p=${entry.upPrice}`);

  return { startMs, slug, ...entry };
}

// ---------------------------------------------------------------------------
// probe: prove the schema before trusting a batch
// ---------------------------------------------------------------------------
if (opt.probe) {
  const startMs = starts[0];
  const slug = slugFor(startMs, slugPrefix);
  console.log(`probe slug : ${slug}`);
  console.log(`probe start: ${new Date(startMs).toISOString()}`);
  try {
    const mk = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
    console.log(`\nGET ${GAMMA}/markets -> HTTP ${mk.status}`);
    console.log(JSON.stringify(mk.json, null, 2).slice(0, 2000));
    const up = Array.isArray(mk.json) && mk.json[0] ? upTokenIdOf(mk.json[0]) : { tokenId: null, error: 'no record' };
    console.log(`\nresolved Up token id: ${up.tokenId ?? `(none: ${up.error})`}`);
    if (up.tokenId) {
      const qs = new URLSearchParams({
        market: up.tokenId,
        startTs: String(Math.floor(startMs / 1000)),
        endTs: String(Math.floor(startMs / 1000) + winSec),
        fidelity: String(fidelity),
      });
      const h = await getJson(`${CLOB}/prices-history?${qs.toString()}`);
      console.log(`\nGET ${CLOB}/prices-history -> HTTP ${h.status}`);
      console.log(JSON.stringify(h.json, null, 2).slice(0, 800));
      const entry = pickEntryPoint(h.json?.history, startMs);
      console.log(`\nentry point chosen: ${entry ? JSON.stringify(entry) : '(none)'}`);
    }
  } catch (err) {
    console.error(`\nprobe FAILED: ${err.message}`);
    console.error('');
    console.error('If that is a timeout, this network cannot reach Polymarket. This script has');
    console.error('to run somewhere that can open https://polymarket.com in a browser.');
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------
const concurrency = Math.max(1, Math.min(16, Number(opt.concurrency) || 4));
console.log(
  `fetching ${starts.length} window(s) | ${new Date(starts[0]).toISOString()} .. ` +
    `${new Date(starts[starts.length - 1]).toISOString()} | slug ${slugPrefix}-<epoch> | ${concurrency} at a time`,
);

const rows = [];
const reasons = new Map();
let done = 0;
let fatal = null;
let cursor = 0;

async function worker() {
  while (cursor < starts.length && !fatal) {
    const start = starts[cursor];
    cursor += 1;
    let got;
    try {
      got = await fetchOne(start);
    } catch (err) {
      fatal = err;
      return;
    }
    if (got.reason) {
      reasons.set(got.reason, (reasons.get(got.reason) ?? 0) + 1);
    } else {
      rows.push(got);
    }
    done += 1;
    if (done % 50 === 0 || done === starts.length) {
      process.stdout.write(`\r  ${done}/${starts.length} windows, ${rows.length} priced    `);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
process.stdout.write('\n');

if (fatal) {
  console.error(`\nABORTED after ${done}/${starts.length}: ${fatal.message}`);
  console.error('Nothing written: a truncated file reads as "the market was only open sometimes".');
  process.exit(1);
}

rows.sort((a, b) => a.startMs - b.startMs);
const lags = rows.map((r) => r.lagSec).sort((a, b) => a - b);
const late = lags.filter((l) => l > maxEntryLag).length;

console.log(`\npriced ${rows.length}/${starts.length} window(s)`);
if (reasons.size) {
  console.log(`unpriced by reason: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
}
if (rows.length) {
  console.log(`entry lag: median ${lags[Math.floor(lags.length / 2)]}s, max ${lags[lags.length - 1]}s, late(>${maxEntryLag}s)=${late}`);
}

if (rows.length === 0) {
  console.error('\nZERO usable rows -- writing nothing. Check --slug-prefix and --window, then run --probe.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, toOddsCsv(rows));

console.log(`\nwrote ${rows.length} row(s) -> ${outPath}`);
console.log('now validate it against the candle file the run will actually use:');
console.log(`  node src/cli.mjs odds-check --odds-file ${path.relative(process.cwd(), outPath)} --file <candles>.csv`);
