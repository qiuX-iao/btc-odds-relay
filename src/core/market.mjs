/**
 * Market windows and resolution -- the exact rules supplied for this market.
 *
 *   Up    : end price  >  start price
 *   Down  : end price  <  start price
 *   Flat  : end price === start price  -> market resolves 50-50
 *
 * Prices come from the Chainlink BTC/USDT top-of-book mid-price stream.
 * The final price is "the close price of the 5m candlestick just before the
 * market's end time" -- i.e. the candle whose closeTime === windowEnd, which is
 * the candle labelled (windowEnd - 5m). Examples from the rules, both must pick
 * the 13:10 candle:
 *
 *   window 13:00 -> 13:15 ET   => end candle labelled 13:10
 *   window 13:10 -> 13:15 ET   => end candle labelled 13:10
 *
 * The start price is taken with the identical convention: the close of the
 * candle whose closeTime === windowStart (labelled windowStart - 5m).
 *
 * If either boundary candle is missing, resolution FAILS LOUDLY. We never
 * interpolate: a missing candle is exactly the "Chainlink data unavailable"
 * case the rules send to the consensus fallback, which is a human decision.
 */

export const UP = 'up';
export const DOWN = 'down';
export const FLAT = 'flat';

export class ResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResolutionError';
    this.code = code;
    this.details = details;
  }
}

/** Window aligned to epoch boundaries that contains ts. */
export function windowContaining(ts, windowMs) {
  const start = Math.floor(ts / windowMs) * windowMs;
  return { start, end: start + windowMs, windowMs };
}

/** Window whose end is the first boundary at or after ts. */
export function windowEndingAtOrAfter(ts, windowMs) {
  const end = Math.ceil(ts / windowMs) * windowMs;
  return { start: end - windowMs, end, windowMs };
}

/** Next window that starts strictly after ts. */
export function nextWindow(ts, windowMs) {
  const start = Math.floor(ts / windowMs) * windowMs + windowMs;
  return { start, end: start + windowMs, windowMs };
}

/** The window that will be resolved next, given "now". */
export function currentOrUpcomingWindow(ts, windowMs) {
  const w = windowContaining(ts, windowMs);
  return ts < w.end ? w : nextWindow(ts, windowMs);
}

/**
 * Compare two boundary prices into the market outcome.
 *
 * The rule is EXACT equality and nothing wider: this market resolves 50-50 only
 * when the two prices are *exactly* equal. There is deliberately no tolerance
 * parameter -- a tolerance band would silently convert a genuine one-tick move
 * into a tie, which is a different market from the one specified.
 *
 * Precision note: prices are JS doubles. Two boundary prices that differ by less
 * than ~1e-15 relative would compare equal. A BTC mid moves by ~1e-7 relative per
 * tick at minimum, so this is ~8 orders of magnitude below anything that can
 * occur; it is recorded here for completeness, not as a live concern.
 */
export function outcomeOf(startPrice, endPrice) {
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice)) {
    throw new ResolutionError('BAD_PRICE', 'start/end price must be finite', {
      startPrice,
      endPrice,
    });
  }
  if (endPrice > startPrice) return UP;
  if (endPrice < startPrice) return DOWN;
  return FLAT;
}

/**
 * Per-share payout for a side under a given outcome.
 * Shares cost `price` and pay this on settlement.
 *   up   : up-side pays 1, down-side pays 0
 *   down : down-side pays 1, up-side pays 0
 *   flat : 50-50 -> both sides pay 0.5
 */
export function settlePayout(side, outcome) {
  if (side !== UP && side !== DOWN) throw new Error(`bad side: ${side}`);
  if (outcome === FLAT) return 0.5;
  return side === outcome ? 1 : 0;
}

/**
 * Why a boundary candle could not be used, in words.
 *
 * `reason` comes from the feed (`partialReason`) and is absent for feeds that do
 * not track coverage -- klines know only that a bucket has not closed, so the
 * wording falls back to that. `still-forming` and `short-coverage` can both be
 * true, and when they are, both are stated.
 */
export function candleRefusalReason(reason) {
  if (!reason) return 'candle still forming';
  const parts = [];
  if (String(reason).includes('still-forming')) parts.push('candle still forming');
  if (String(reason).includes('short-coverage')) {
    parts.push('recording did not cover the whole interval');
  }
  return parts.length ? parts.join('; ') : 'candle unusable';
}

/**
 * Resolve a window from a candle series.
 *
 * @param {object} args
 * @param {number} args.windowStart epoch ms, inclusive
 * @param {number} args.windowEnd   epoch ms, exclusive; also the settle instant
 * @param {import('./candles.mjs').CandleSeries} args.series
 * @param {number} args.candleMs candle interval (defaults to the series candles')
 * @returns {object} resolution record
 */
export function resolveFromSeries({ windowStart, windowEnd, series, candleMs = null }) {
  const interval = candleMs ?? series?.last?.intervalMs ?? null;
  if (!series || !series.size) {
    throw new ResolutionError('NO_DATA', 'no candles available for resolution', {
      windowStart,
      windowEnd,
    });
  }
  if (!interval) {
    throw new ResolutionError('NO_INTERVAL', 'cannot infer candle interval', { windowStart });
  }
  if (windowEnd - windowStart < interval) {
    throw new ResolutionError(
      'WINDOW_TOO_SHORT',
      `window ${windowEnd - windowStart}ms is shorter than one ${interval}ms candle`,
      { windowStart, windowEnd, interval },
    );
  }
  if ((windowEnd - windowStart) % interval !== 0) {
    throw new ResolutionError(
      'MISALIGNED_WINDOW',
      `window length ${windowEnd - windowStart}ms is not a multiple of the ${interval}ms candle`,
      { windowStart, windowEnd, interval },
    );
  }
  if (windowStart % interval !== 0 || windowEnd % interval !== 0) {
    throw new ResolutionError(
      'MISALIGNED_BOUNDARY',
      'window boundaries are not aligned to candle boundaries',
      { windowStart, windowEnd, interval },
    );
  }

  const startCandle = series.get(windowStart);
  const endCandle = series.get(windowEnd);
  const missing = [];
  if (!startCandle) missing.push({ role: 'start', expectedCloseTime: windowStart });
  if (!endCandle) missing.push({ role: 'end', expectedCloseTime: windowEnd });
  // A still-forming bucket is NOT a bucket close. Refuse it rather than settle
  // on a price the rules would not read off the chart.
  //
  // A candle can be unusable for the opposite reason too: CLOSED, but only a
  // fragment of its interval, because a recording started or stopped inside it.
  // Both are refused here (the code is the same: the boundary candle exists but
  // is not a candle), but the message names which one it is -- asserting "still
  // forming" over a bucket that closed minutes ago sends the reader looking for
  // the wrong problem. `partialReason` is set by feeds that know their coverage
  // (see `CsvFeed`) and absent for feeds that do not, in which case the old
  // wording still applies.
  if (startCandle?.partial) {
    missing.push({ role: 'start', expectedCloseTime: windowStart, partial: true, reason: startCandle.partialReason ?? null });
  }
  if (endCandle?.partial) {
    missing.push({ role: 'end', expectedCloseTime: windowEnd, partial: true, reason: endCandle.partialReason ?? null });
  }
  if (missing.length) {
    const detail = missing
      .map((m) => `${m.role}@${m.expectedCloseTime}${m.partial ? ` (${candleRefusalReason(m.reason)})` : ''}`)
      .join(', ');
    throw new ResolutionError(
      missing.some((m) => m.partial) ? 'PARTIAL_CANDLE' : 'MISSING_CANDLE',
      `boundary candle unusable: ${detail}`,
      { windowStart, windowEnd, interval, missing },
    );
  }

  const startPrice = startCandle.close;
  const endPrice = endCandle.close;
  const outcome = outcomeOf(startPrice, endPrice);
  return {
    kind: 'resolution',
    windowStart,
    windowEnd,
    intervalMs: interval,
    startCandle: pickCandle(startCandle),
    endCandle: pickCandle(endCandle),
    startPrice,
    endPrice,
    delta: endPrice - startPrice,
    deltaBps: startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 10000 : NaN,
    outcome,
    source: series.source ?? startCandle.source ?? endCandle.source ?? 'unknown',
    resolvedAt: windowEnd,
    ruleVersion: 'chainlink-btcusdt-topofbook-mid/5m-close-v1',
  };
}

function pickCandle(c) {
  return {
    openTime: c.openTime,
    closeTime: c.closeTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ticks: c.ticks,
    partial: !!c.partial,
    source: c.source ?? null,
  };
}

/**
 * Resolve from explicit boundary prices (manual verification path, e.g. the user
 * reads two numbers off the Chainlink stream page).
 */
export function resolveFromPrices({ windowStart, windowEnd, startPrice, endPrice, source = 'manual' }) {
  return {
    kind: 'resolution',
    windowStart,
    windowEnd,
    intervalMs: null,
    startCandle: null,
    endCandle: null,
    startPrice,
    endPrice,
    delta: endPrice - startPrice,
    deltaBps: startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 10000 : NaN,
    outcome: outcomeOf(startPrice, endPrice),
    source,
    resolvedAt: windowEnd,
    ruleVersion: 'chainlink-btcusdt-topofbook-mid/5m-close-v1',
  };
}

/**
 * Plain-language trace of a resolution, for CLI output and audit logs.
 */
export function describeResolution(rec, { etLabel, etClock, windowLabel } = {}) {
  const labelStart = etLabel ? etLabel(rec.windowStart) : new Date(rec.windowStart).toISOString();
  const labelEnd = etClock ? etClock(rec.windowEnd) : new Date(rec.windowEnd).toISOString();
  const range = windowLabel
    ? windowLabel(rec.windowStart, rec.windowEnd)
    : `${labelStart} -> ${labelEnd}`;
  const endCandleLabel = rec.endCandle
    ? `${etLabel ? etLabel(rec.endCandle.openTime) : rec.endCandle.openTime} (closeTime ${rec.endCandle.closeTime})`
    : 'n/a (prices supplied manually)';
  const lines = [
    `window          : ${range}`,
    `start candle    : ${rec.startCandle ? `${(etLabel ? etLabel(rec.startCandle.openTime) : rec.startCandle.openTime)} (closeTime ${rec.startCandle.closeTime})` : 'n/a (prices supplied manually)'}`,
    `end candle      : ${endCandleLabel}`,
    `start price     : ${rec.startPrice}`,
    `end price       : ${rec.endPrice}`,
    `delta           : ${rec.delta > 0 ? '+' : ''}${rec.delta} (${Number.isFinite(rec.deltaBps) ? rec.deltaBps.toFixed(2) : 'n/a'} bps)`,
    `outcome         : ${rec.outcome.toUpperCase()}${rec.outcome === FLAT ? ' (50-50 settlement)' : ''}`,
    `source          : ${rec.source}`,
  ];
  return lines.join('\n');
}

/**
 * When the bot must commit to a position inside a window.
 *
 * `spec` is either
 *   'open' | 'start'  -> decide the instant the window opens (lead = full window)
 *   'close' | 'end'   -> decide at the close. This is NOT a forecast: see
 *                        `isLookaheadDecision` below.
 *   a duration        -> decide that long BEFORE the window ends, e.g. '5m'
 *
 * Durations longer than the window are clamped to the window open, so the
 * decision timestamp can never precede the window.
 *
 * @param {{windowStart:number, windowEnd:number, spec:string|number}} args
 * @returns {number} decision timestamp (ms)
 */
export function resolveDecisionTs({ windowStart, windowEnd, spec = 'open' }) {
  if (spec === 'open' || spec === 'start') return windowStart;
  if (spec === 'close' || spec === 'end') return windowEnd;
  const ms = parseIntervalSpec(spec);
  return Math.max(windowStart, windowEnd - ms);
}

/**
 * True when the decision instant is the instant the window resolves.
 *
 * This is a property of the resolved TIMESTAMP, not of the `spec` string, so
 * `'close'`, `'end'` and a duration of one whole window all answer `true` --
 * anything that lands on `windowEnd`.
 *
 * Why it matters, measured rather than argued: at `windowEnd` the closing bucket
 * has closed, so the price the market resolves on is a price the model can read.
 * `partialReturn` becomes the full window return, and the diffusion signal -- a
 * formula whose entire job is to compare the window close against the window open
 * -- returns the answer. On 1983 settled windows of real BTC 5m klines a
 * diffusion-only pool scored **100.00%** here, against 48% at the open. A run
 * configured this way is not a skilful model; it is arithmetic, and whichever
 * accuracy it prints is the outcome wearing a forecast's clothes.
 *
 * `'close'` remains reachable for diagnostics (it is a useful ceiling), but the
 * caller has to say so out loud -- see `strategy.allowLookaheadDecision`.
 */
export function isLookaheadDecision({ windowStart, windowEnd, spec = 'open' }) {
  return resolveDecisionTs({ windowStart, windowEnd, spec }) >= windowEnd;
}

function parseIntervalSpec(spec) {
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec) || spec < 0) throw new Error(`bad decision offset: ${spec}`);
    return spec;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(spec).trim());
  if (!m) {
    throw new Error(
      `bad strategy.decisionOffset "${spec}": use 'open', 'close', or a duration like '5m'`,
    );
  }
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Math.round(Number(m[1]) * unit);
}

/** Upcoming window boundaries, for a `markets` listing. */export function upcomingWindows(now, windowMs, count, candleMs = null) {
  const out = [];
  let w = currentOrUpcomingWindow(now, windowMs);
  for (let i = 0; i < count; i += 1) {
    out.push({
      ...w,
      startCandleCloseTime: w.start,
      endCandleCloseTime: w.end,
      endCandleOpenTime: candleMs ? w.end - candleMs : w.end - 300000,
    });
    w = nextWindow(w.start, windowMs);
  }
  return out;
}
