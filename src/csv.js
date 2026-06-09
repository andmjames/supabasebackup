'use strict';

/**
 * Turn a single JS value (as returned by node-postgres) into a CSV field.
 *
 * Conventions used for this backup:
 *   - SQL NULL            -> empty, UNQUOTED field   (distinguishable from "")
 *   - empty string ""     -> "" (an explicitly quoted empty string)
 *   - objects / arrays    -> JSON.stringify (jsonb, json, array columns)
 *   - Date                -> ISO 8601 string
 *   - Buffer (bytea)      -> hex string prefixed with \\x (Postgres style)
 *   - everything else     -> String(value)
 * Any field that contains a comma, quote, CR or LF is wrapped in double
 * quotes with internal quotes doubled (RFC 4180).
 */
function formatField(value) {
  if (value === null || value === undefined) return ''; // unquoted -> NULL

  let str;
  if (Buffer.isBuffer(value)) {
    str = '\\x' + value.toString('hex');
  } else if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }

  // Always quote so an empty string survives as "" (not read back as NULL),
  // and so commas/quotes/newlines are safe.
  return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Build a full CSV document (with header row) from node-postgres query output.
 * @param {Array<{name:string}>} fields  - result.fields from pg
 * @param {Array<object>} rows            - result.rows from pg
 * @returns {string}
 */
function buildCsv(fields, rows) {
  const columns = fields.map((f) => f.name);
  const lines = [];

  // Header: quote every column name for safety.
  lines.push(columns.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(','));

  for (const row of rows) {
    lines.push(columns.map((c) => formatField(row[c])).join(','));
  }

  // Trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildCsv, formatField };
