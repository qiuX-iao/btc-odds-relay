/**
 * Entry-price (odds) providers.
 *
 * IMPORTANT honesty note about evaluation:
 * A backtest can only measure an edge against prices that are INDEPENDENT of the
 * model. So there are exactly two supported modes, and no "model generates its
 * own odds" mode (that would be circular and always look profitable):
 *
 *   fair  : every window is entered at 0.50. PnL is then a pure function of
 *           directional accuracy at even odds: win +stake, lose -stake.
 *           This is the default and the honest test of direction prediction.
 *   csv   : real recorded contract prices, one row per window
 *           (windowStart, upPrice[, downPrice]). Needed to measure whether the
 *           model beats the market -- the only setting where edge capture is real.
 */
import fs from 'node:fs';
import { parseCsvObjects } from '../util/csv.mjs';
import { toEpochMs } from '../util/time.mjs';
import { DOWN, UP } from './market.mjs';

export class OddsError extends Error {
  constructor(msg, details = {}) {
    super(msg);
    this.name = 'OddsError';
    this.details = details;
  }
}

/** First present, non-empty alias from a list. */
function pick(row, names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * Canonicalise ONE csv row into the shape the provider and the auditor both use.
 *
 * Both call this, deliberately: if the auditor accepted rows the provider
 * rejected (or the reverse), `odds-check` would bless a file that then silently
 * fails every window -- exactly the trap it exists to catch.
 *
 * @returns {{windowStart:number,upPrice:number,downPrice:number,downPriceGiven:boolean}
 *           | {error:string}}
 */
function parseOddsRow(row) {
  const wsRaw = pick(row, ['windowStart', 'window', 'start', 'time']);
  const windowStart = toEpochMs(wsRaw);
  if (!Number.isFinite(windowStart)) {
    return { error: wsRaw === null ? 'no windowStart column' : `unparsable windowStart: ${wsRaw}` };
  }
  const upRaw = pick(row, ['upPrice', 'up_price', 'price']);
  if (upRaw === null) return { error: 'no upPrice column' };
  const upPrice = Number(upRaw);
  if (!Number.isFinite(upPrice)) return { error: `unparsable upPrice: ${upRaw}` };
  const downRaw = pick(row, ['downPrice', 'down_price']);
  const downPriceGiven = downRaw !== null;
  const downPrice = downPriceGiven ? Number(downRaw) : 1 - upPrice;
  return { windowStart, upPrice, downPrice, downPriceGiven };
}

/**
 * A price is only usable as an entry price if it is strictly inside (0,1).
 * Exported so the Polymarket fetch tool applies the same rule rather than
 * restating it (a second copy is a second thing to drift).
 */
export function priceIsUsable(p) {
  return Number.isFinite(p) && p > 0 && p < 1;
}

/**
 * Window starts a backtest will actually ask for a price, given a candle series
 * running [firstCloseTime, lastCloseTime].
 *
 * A window needs BOTH boundary candles: one whose closeTime === windowStart and
 * one whose closeTime === windowStart + windowMs (see market.mjs). The backtest
 * therefore begins at the first epoch-aligned start at or after the series'
 * first close (`Math.ceil`, mirroring backtest/engine.mjs) -- the window that
 * would have started earlier cannot be resolved, because its START candle is
 * not in the history. Starting from `floor` instead would make this estimator
 * claim one extra window at the front and report it as "missing" from a price
 * file, when no run would ever have asked for it.
 *
 * Gaps in the candle series are not modelled here: this is a pre-flight
 * estimate, and a gap can only ever make the real set smaller.
 *
 * @returns {number[]} ascending window starts
 */
export function windowStartsInRange(firstCloseTime, lastCloseTime, windowMs) {
  if (!Number.isFinite(firstCloseTime) || !Number.isFinite(lastCloseTime) || !(windowMs > 0)) {
    return [];
  }
  const out = [];
  for (let s = Math.ceil(firstCloseTime / windowMs) * windowMs; s + windowMs <= lastCloseTime; s += windowMs) {
    out.push(s);
  }
  return out;
}

/**
 * Audit an odds CSV BEFORE a run is trusted to it.
 *
 * Why this exists: the provider resolves a window's entry price by EXACT lookup
 * on the window's epoch-aligned start. A file whose timestamps are shifted by a
 * second, or written in local time, matches nothing -- every window is skipped,
 * the run reports zero trades, and nothing anywhere says why. The coverage
 * counters were real but never surfaced. So this returns a plain report of what
 * is wrong; it throws only when the file itself cannot be read.
 *
 * @param {string} file
 * @param {{windowMs?:number, expectedWindows?:number[]|null, maxSamples?:number}} [opts]
 * @returns {object} report (never throws for bad rows)
 */
export function auditOddsCsv(file, opts = {}) {
  const { windowMs = null, expectedWindows = null, maxSamples = 8 } = opts;
  const report = {
    file,
    exists: false,
    header: [],
    rows: 0,
    usable: 0,
    rejected: [],
    rejectedCount: 0,
    duplicates: [],
    duplicateCount: 0,
    distinctWindows: 0,
    outOfRange: [],
    outOfRangeCount: 0,
    downPriceMissing: 0,
    priceRange: null,
    windowMs,
    misaligned: [],
    misalignedCount: 0,
    gapWindows: [],
    gapCount: 0,
    firstWindowStart: null,
    lastWindowStart: null,
    coverage: null,
  };
  if (!file || !fs.existsSync(file)) return report;
  report.exists = true;

  const objects = parseCsvObjects(fs.readFileSync(file, 'utf8'));
  report.header = objects.length ? Object.keys(objects[0]) : [];
  report.rows = objects.length;

  const seen = new Set();
  const windows = [];
  const prices = [];
  for (const row of objects) {
    const parsed = parseOddsRow(row);
    if (parsed.error) {
      report.rejectedCount += 1;
      if (report.rejected.length < maxSamples) report.rejected.push(parsed.error);
      continue;
    }
    const { windowStart, upPrice, downPrice, downPriceGiven } = parsed;
    if (!downPriceGiven) report.downPriceMissing += 1;
    if (!priceIsUsable(upPrice) || !priceIsUsable(downPrice)) {
      report.outOfRangeCount += 1;
      if (report.outOfRange.length < maxSamples) {
        report.outOfRange.push({ windowStart, upPrice, downPrice });
      }
      continue;
    }
    if (seen.has(windowStart)) {
      report.duplicateCount += 1;
      if (report.duplicates.length < maxSamples) report.duplicates.push(windowStart);
      continue; // first row wins, same as the provider's Map.set ordering
    }
    seen.add(windowStart);
    windows.push(windowStart);
    prices.push(upPrice, downPrice);
  }

  report.usable = windows.length;
  report.distinctWindows = seen.size;
  report.firstWindowStart = windows.length ? Math.min(...windows) : null;
  report.lastWindowStart = windows.length ? Math.max(...windows) : null;
  report.priceRange = prices.length
    ? { min: Math.min(...prices), max: Math.max(...prices) }
    : null;

  if (windowMs) {
    for (const w of windows) {
      if (w % windowMs !== 0) {
        report.misalignedCount += 1;
        if (report.misaligned.length < maxSamples) {
          report.misaligned.push({ windowStart: w, offsetMs: w % windowMs });
        }
      }
    }
    // Interior holes inside the file's own span.
    if (windows.length > 1) {
      const sorted = [...windows].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] - sorted[i - 1] > windowMs) {
          report.gapCount += Math.round((sorted[i] - sorted[i - 1]) / windowMs) - 1;
          if (report.gapWindows.length < maxSamples) {
            report.gapWindows.push({ after: sorted[i - 1], before: sorted[i] });
          }
        }
      }
    }
  }

  if (expectedWindows && expectedWindows.length) {
    const missing = expectedWindows.filter((w) => !seen.has(w));
    report.coverage = {
      expected: expectedWindows.length,
      covered: expectedWindows.length - missing.length,
      fraction: (expectedWindows.length - missing.length) / expectedWindows.length,
      missingCount: missing.length,
      missingFirst: missing.slice(0, maxSamples),
    };
  }
  return report;
}

/**
 * Turn an audit report into the two verdict lists a caller can act on.
 *
 * Kept here (not in the CLI) so it can be tested without spawning a process, and
 * so the severity model has exactly one definition. The split matters:
 *   errors   -> the file cannot be used at all, or is internally broken;
 *   warnings -> the file is usable but incomplete.
 * Partial coverage is deliberately a warning. It shrinks the sample, which is
 * serious, but flagging it as fatal would make this command cry wolf and get
 * ignored -- and the run itself already warns and the report already banners it.
 *
 * @param {object} report from auditOddsCsv
 * @param {{windowLabel?:string}} [opts]
 * @returns {{errors:string[], warnings:string[]}}
 */
export function judgeOddsAudit(report, opts = {}) {
  const windowLabel = opts.windowLabel ?? 'window';
  const errors = [];
  const warnings = [];
  if (!report.exists) {
    errors.push(`odds file not found: ${report.file}`);
    return { errors, warnings };
  }
  if (!report.usable) errors.push('no usable rows (need windowStart and an upPrice in (0,1))');
  if (report.rejectedCount) errors.push(`${report.rejectedCount} row(s) unparsable`);
  if (report.outOfRangeCount) {
    errors.push(
      `${report.outOfRangeCount} row(s) with a price outside (0,1) — a binary contract cannot be entered there`,
    );
  }
  if (report.duplicateCount) {
    errors.push(
      `${report.duplicateCount} duplicate windowStart row(s) — only the first is used, silently discarding the rest`,
    );
  }
  if (report.misalignedCount) {
    errors.push(
      `${report.misalignedCount} row(s) not aligned to a ${windowLabel} epoch boundary — these can NEVER match a window, because the lookup is an exact epoch match`,
    );
  }
  if (report.coverage) {
    if (report.coverage.fraction === 0) {
      errors.push(
        `not one of the ${report.coverage.expected} resolvable window(s) has a price — this file does not describe this candle range at all`,
      );
    } else if (report.coverage.fraction < 1) {
      warnings.push(
        `${report.coverage.missingCount} of ${report.coverage.expected} resolvable window(s) have no price; a run would skip them and measure a smaller sample`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * @param {object} cfg odds section of config
 * @returns {{mode:string, priceFor:(args:{windowStart:number, side:'up'|'down'})=>number, describe:()=>string}}
 */
export function makeOddsProvider(cfg) {
  const mode = cfg?.mode ?? 'fair';
  if (mode === 'fair') {
    return {
      mode,
      priceFor: () => 0.5,
      describe: () => 'fair (0.50 on both sides; PnL = directional accuracy at even odds)',
    };
  }
  if (mode === 'csv') {
    if (!cfg.file) throw new OddsError('odds.mode=csv requires odds.file');
    if (!fs.existsSync(cfg.file)) throw new OddsError(`odds file not found: ${cfg.file}`);
    const rows = parseCsvObjects(fs.readFileSync(cfg.file, 'utf8'));
    const table = new Map();
    for (const r of rows) {
      // windowStart may be epoch ms, epoch seconds, or an ISO 8601 string
      const parsed = parseOddsRow(r);
      if (parsed.error) continue;
      // FIRST occurrence wins, explicitly. A plain Map.set would let the last
      // row silently override every earlier one, which means a stray row
      // appended to the end of an export would rewrite history. Duplicates are
      // reported as fatal by the audit either way, so this only decides which
      // of two ambiguous rows a run uses if the operator ignores that -- and
      // file order is the more defensible tie-break than "whichever is last".
      if (table.has(parsed.windowStart)) continue;
      // An un-usable price is kept as-is (not dropped) so the caller can tell
      // "no row for this window" apart from "row present but unusable"; the
      // auditor reports both as rejected rather than inventing a price.
      table.set(parsed.windowStart, { upPrice: parsed.upPrice, downPrice: parsed.downPrice });
    }
    if (!table.size) {
      throw new OddsError(`odds CSV ${cfg.file} produced no usable rows (need windowStart, upPrice)`);
    }
    return {
      mode,
      priceFor: ({ windowStart, side }) => {
        const row = table.get(windowStart);
        if (!row) return null; // caller must skip this window (no market price known)
        const p = side === UP ? row.upPrice : row.downPrice;
        return Number.isFinite(p) ? p : null;
      },
      has: (windowStart) => table.has(windowStart),
      size: table.size,
      describe: () => `csv (${table.size} windows from ${cfg.file})`,
    };
  }
  throw new OddsError(`unknown odds.mode: ${mode}`);
}

/** Helper: complement price, clamped away from 0/1. */
export function complementPrice(p) {
  return Math.min(0.999, Math.max(0.001, 1 - p));
}

export { UP, DOWN };
