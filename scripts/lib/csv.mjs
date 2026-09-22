/**
 * Dependency-free CSV parsing, tolerant of what analytics tools actually export.
 *
 * Handles: UTF-8 BOM, CRLF, quoted fields containing delimiters or newlines,
 * doubled quotes as escapes, and comma / semicolon / tab delimiters (AWR's
 * European exports use semicolons, and Excel re-saves often use tabs).
 */

/** Picks the delimiter that yields the most columns on the header line. */
export function sniffDelimiter(text) {
  const firstLine = text.slice(0, 8192).split(/\r?\n/)[0] || '';
  const candidates = [',', ';', '\t', '|'];

  let best = ',';
  let bestCount = 0;
  for (const delimiter of candidates) {
    // Count only delimiters outside quoted regions.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const char = firstLine[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === delimiter && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  return best;
}

/**
 * Parses CSV text into an array of string arrays.
 * @returns {string[][]}
 */
export function parseCsv(input, delimiter) {
  // Strip a UTF-8 BOM, which otherwise corrupts the first header name.
  const text = input.replace(/^﻿/, '');
  const sep = delimiter || sniffDelimiter(text);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  // Flush whatever the final line left behind.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Parses CSV into objects keyed by header name.
 * Exports often carry preamble lines before the real header, so the header is
 * taken to be the first row that matches `looksLikeHeader`.
 */
export function parseCsvRows(input, { looksLikeHeader } = {}) {
  const rows = parseCsv(input);
  if (!rows.length) return { headers: [], rows: [], headerIndex: -1 };

  let headerIndex = 0;
  if (looksLikeHeader) {
    const found = rows.findIndex((row) => looksLikeHeader(row));
    if (found >= 0) headerIndex = found;
  }

  const headers = rows[headerIndex].map((h) => h.trim());
  const body = rows.slice(headerIndex + 1).map((row) => {
    const record = {};
    headers.forEach((header, i) => {
      record[header] = (row[i] ?? '').trim();
    });
    return record;
  });

  return { headers, rows: body, headerIndex };
}
