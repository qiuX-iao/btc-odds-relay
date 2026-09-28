/**
 * Pure helpers for reading Polymarket's 5m/15m "Bitcoin Up or Down" markets.
 *
 * Why Polymarket: it publishes exactly the market these rules describe -- a
 * binary Up/Down contract per time window, settled on the Chainlink BTC/USD
 * data stream, paying $1 per winning share. Its read endpoints (Gamma for
 * metadata, CLOB for price history) are public: no key, no account, no signup.
 *
 * Why a module instead of inlining this in the fetch tool: the fetch needs a
 * network that can reach Polymarket, but everything that decides WHAT a row
 * means -- the slug, which token is "Up", which sample counts as the entry
 * price -- can be pinned with fixtures offline. A tool whose parsing has never
 * been tested is a tool that reports numbers you cannot check.
 */

/**
 * The slug a market is published under: `<prefix>-<windowStartEpochSeconds>`.
 *
 * The number is the window's START instant, which is also the `windowStart`
 * column this project matches on -- so the join key comes from the source
 * rather than being reconstructed (and possibly shifted) here.
 *
 * Verified against two live URLs: `btc-updown-15m-1778871600` decodes to
 * 2026-05-15T19:00:00Z == 3:00 PM ET, matching that market's own title.
 *
 * @returns {string|null} null if windowStartMs is not a finite number
 */
export function slugFor(windowStartMs, prefix = 'btc-updown-15m') {
  if (!Number.isFinite(windowStartMs)) return null;
  return `${prefix}-${Math.floor(windowStartMs / 1000)}`;
}

/**
 * Pull the Up outcome's CLOB token id out of a Gamma market record.
 *
 * Both `outcomes` and `clobTokenIds` arrive as JSON-encoded STRINGS, and the
 * outcome order is not something to assume -- a market that lists ["Down","Up"]
 * would hand back the Down token to a parser that hardcoded index 0. The index
 * is therefore found by name.
 *
 * @returns {{tokenId: string|null, outcomes: string[], error?: string}}
 */
export function upTokenIdOf(market) {
  if (!market) return { tokenId: null, outcomes: [], error: 'no market record' };
  let outcomes;
  let tokens;
  try {
    outcomes = JSON.parse(market.outcomes ?? '[]');
    tokens = JSON.parse(market.clobTokenIds ?? '[]');
  } catch (err) {
    return { tokenId: null, outcomes: [], error: `unparsable outcomes/clobTokenIds: ${err.message}` };
  }
  if (!Array.isArray(outcomes) || !Array.isArray(tokens)) {
    return { tokenId: null, outcomes: [], error: 'outcomes/clobTokenIds are not arrays' };
  }
  const iUp = outcomes.findIndex((o) => /^up$/i.test(String(o).trim()));
  if (iUp < 0) return { tokenId: null, outcomes, error: `no "Up" outcome among ${JSON.stringify(outcomes)}` };
  if (!tokens[iUp]) return { tokenId: null, outcomes, error: 'token array shorter than outcome array' };
  return { tokenId: String(tokens[iUp]), outcomes };
}

/**
 * The entry price for a window: the FIRST quoted point at or after the open.
 *
 * That is the price visible at the moment of committing at the open, which is
 * what `--decision open` (the default) models. Price history is sampled in
 * whole minutes, so the chosen instant is usually a few seconds to a minute
 * after the open -- the lag is returned rather than hidden, because a sample
 * taken 55 seconds into a 5-minute window describes a different moment than one
 * taken at the open, and the caller must be able to say so.
 *
 * @returns {{entryAt:number, upPrice:number, lagSec:number}|null}
 */
export function pickEntryPoint(history, windowStartMs) {
  if (!Array.isArray(history) || history.length === 0) return null;
  if (!Number.isFinite(windowStartMs)) return null;
  const startSec = Math.floor(windowStartMs / 1000);
  const at = history.find((p) => Number(p.t) >= startSec) ?? history[0];
  const entryAt = Number(at.t);
  const upPrice = Number(at.p);
  if (!Number.isFinite(entryAt) || !Number.isFinite(upPrice)) return null;
  return { entryAt, upPrice, lagSec: entryAt - startSec };
}

/**
 * Window starts a fetch should request: epoch-aligned, and only those whose own
 * close fits inside the range.
 *
 * Deliberately the same alignment the backtest engine and the odds auditor use
 * (`Math.ceil`). A `floor` here would request one extra window at the front --
 * one the engine would never ask about -- and then report it as "missing
 * coverage" from a file that was complete.
 *
 * @returns {number[]} ascending window start instants (ms)
 */
export function windowStartsBetween(fromMs, toMs, windowMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(windowMs > 0)) return [];
  const out = [];
  for (let s = Math.ceil(fromMs / windowMs) * windowMs; s + windowMs <= toMs; s += windowMs) {
    out.push(s);
  }
  return out;
}

/**
 * Render fetched rows as the CSV `--odds csv` consumes.
 *
 * `windowStart` is epoch milliseconds ON PURPOSE. README section 8 is explicit
 * that a one-second shift in an ISO timestamp makes a row match NOTHING, and the
 * usual cause is a formatter -- so the one column that must be exact is written
 * in the format that has no formatting rule to get wrong. The ISO instant and the
 * sampling columns ride along for humans; the parser picks columns by name and
 * ignores everything else.
 *
 * Kept here rather than in the fetch tool so the output-shape contract with the
 * parser can be tested without a network.
 *
 * @param {Array<{startMs:number,upPrice:number,entryAt?:number,lagSec?:number,slug?:string}>} rows
 * @returns {string}
 */
export function toOddsCsv(rows) {
  const header = 'windowStart,upPrice,downPrice,windowStartIso,entryAt,entryLagSec,slug';
  const lines = (rows ?? []).map((r) =>
    [
      r.startMs,
      Number(r.upPrice).toFixed(4),
      (1 - Number(r.upPrice)).toFixed(4),
      new Date(r.startMs).toISOString(),
      r.entryAt ?? '',
      r.lagSec ?? '',
      r.slug ?? '',
    ].join(','),
  );
  return `${header}\n${lines.join('\n')}\n`;
}
