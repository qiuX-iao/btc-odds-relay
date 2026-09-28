/**
 * Time helpers.
 *
 * Alignment note (important for the resolution rules):
 * Market windows are aligned on absolute epoch boundaries. ET (America/New_York)
 * is a whole number of hours offset from UTC, so ":00/:15/:30/:45" alignment is
 * identical in ET and UTC. ET is therefore used only for *labelling / display*,
 * never for the arithmetic that picks which candle closes a window.
 */

export const MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const UNIT_MS = {
  s: MS.s,
  m: MS.m,
  h: MS.h,
  d: MS.d,
};

/**
 * Parse an interval spec such as "5m", "15m", "1h", "30s", "1d".
 * @param {string|number} spec
 * @returns {number} milliseconds
 */
export function parseInterval(spec) {
  if (typeof spec === 'number') {
    if (!Number.isFinite(spec) || spec <= 0) throw new Error(`bad interval: ${spec}`);
    return spec;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(spec).trim());
  if (!m) throw new Error(`bad interval spec: ${spec}`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2]]);
}

export function alignDown(ts, intervalMs) {
  return Math.floor(ts / intervalMs) * intervalMs;
}

export function alignUp(ts, intervalMs) {
  return Math.ceil(ts / intervalMs) * intervalMs;
}

export function alignNearest(ts, intervalMs) {
  return Math.round(ts / intervalMs) * intervalMs;
}

export function floorToMinutes(ts, minutes) {
  return alignDown(ts, minutes * MS.m);
}

/** Human readable UTC ISO without milliseconds. */
export function isoUtc(ts) {
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

export function isoUtcMinute(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * "2026-01-05 13:10 ET" for a timestamp (handles DST automatically).
 * @param {number} ts
 */
export function etLabel(ts) {
  const parts = Object.fromEntries(
    ET_FMT.formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ET`;
}

/** "13:10 ET" short form. */
export function etClock(ts) {
  return etLabel(ts).slice(11);
}

/** Signed UTC offset of ET at a given instant, in minutes (for display). */
export function etOffsetMinutes(ts) {
  const utc = new Date(ts);
  const et = new Date(utc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((et.getTime() - utc.getTime()) / MS.m);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  const sign = ms < 0 ? '-' : '';
  let v = Math.abs(ms);
  if (v < 1000) return `${sign}${v}ms`;
  if (v < MS.m) return `${sign}${(v / 1000).toFixed(v < 10 * 1000 ? 1 : 0)}s`;
  if (v < MS.h) return `${sign}${(v / MS.m).toFixed(v < 10 * MS.m ? 1 : 0)}m`;
  if (v < MS.d) return `${sign}${(v / MS.h).toFixed(1)}h`;
  return `${sign}${(v / MS.d).toFixed(1)}d`;
}

/**
 * Human label for a market window, in both ET and UTC.
 * @param {number} start
 * @param {number} end
 */
export function windowLabel(start, end) {
  return `${etLabel(start)} -> ${etClock(end)} (${formatDuration(end - start)})`;
}

/**
 * Parse a timestamp that may be epoch ms, epoch seconds, or an ISO 8601 string.
 * Returns NaN when it cannot be understood.
 * @param {string|number|null|undefined} value
 * @returns {number} epoch ms or NaN
 */
export function toEpochMs(value) {
  if (value === null || value === undefined) return NaN;
  const s = String(value).trim();
  if (s === '') return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Math.abs(n) > 1e11) return Math.round(n); // ms
    if (Math.abs(n) > 1e8) return Math.round(n * 1000); // seconds
    return NaN;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Sleep that works with an injectable clock.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
