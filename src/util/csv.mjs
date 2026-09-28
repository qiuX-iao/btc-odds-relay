/**
 * Minimal CSV reader/writer (RFC4180-ish: quotes, escaped quotes, CRLF).
 */

/**
 * @param {string} text
 * @returns {{header: string[], rows: string[][]}}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    // skip fully empty trailing rows
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length) {
    pushField();
    pushRow();
  }
  const header = rows.length ? rows[0].map((h) => h.trim()) : [];
  return { header, rows: rows.slice(1) };
}

/**
 * Parse CSV into objects keyed by header. Empty cells become null.
 * @param {string} text
 */
export function parseCsvObjects(text) {
  const { header, rows } = parseCsv(text);
  return rows.map((r) => {
    const o = {};
    header.forEach((h, i) => {
      const v = r[i];
      o[h] = v === undefined || v === '' ? null : v;
    });
    return o;
  });
}

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {object[]} rows
 * @param {string[]} [columns]
 */
export function toCsv(rows, columns) {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
