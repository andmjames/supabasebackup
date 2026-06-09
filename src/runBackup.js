'use strict';

const JSZip = require('jszip');
const { buildCsv } = require('./csv');
const { sendBackupEmail } = require('./email');
const { withClient } = require('./db');

/** Throw if the email-related env vars are missing. */
function checkEmailEnv() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'BACKUP_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set these in Netlify → Site settings → Environment variables.`
    );
  }
}

/** Safely double-quote a Postgres identifier. */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Local date label in Eastern (YYYY-MM-DD). */
function dateLabel() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indiana/Indianapolis',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Dump every base table in the configured schema(s) to CSV using the given
 * already-connected pg client, zip them, and email the zip.
 * @param {import('pg').Client} client
 * @returns summary object
 */
async function dumpAndEmail(client) {
  checkEmailEnv();

  const schemas = (process.env.BACKUP_SCHEMAS || 'public')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const startedAt = Date.now();
  const zip = new JSZip();
  const manifest = [];
  let totalRows = 0;

  const tablesRes = await client.query(
    `SELECT schemaname, tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname = ANY($1::text[])
      ORDER BY schemaname, tablename`,
    [schemas]
  );
  if (tablesRes.rows.length === 0) {
    throw new Error(`No tables found in schema(s): ${schemas.join(', ')}`);
  }

  for (const { schemaname, tablename } of tablesRes.rows) {
    const fqName = `${schemaname}.${tablename}`;
    try {
      const res = await client.query(
        `SELECT * FROM ${quoteIdent(schemaname)}.${quoteIdent(tablename)}`
      );
      zip.file(`${fqName}.csv`, buildCsv(res.fields, res.rows));
      manifest.push(`${fqName}: ${res.rows.length} rows`);
      totalRows += res.rows.length;
      console.log(`Dumped ${fqName} (${res.rows.length} rows)`);
    } catch (tableErr) {
      const msg = `${fqName}: ERROR — ${tableErr.message}`;
      manifest.push(msg);
      console.error(msg);
    }
  }

  const label = dateLabel();
  const tableCount = tablesRes.rows.length;

  zip.file(
    '_manifest.txt',
    `Supabase backup\n` +
      `Generated: ${new Date().toISOString()} (UTC)\n` +
      `Date: ${label} (Eastern)\n` +
      `Schemas: ${schemas.join(', ')}\n` +
      `Tables: ${tableCount}\n` +
      `Total rows: ${totalRows}\n\n` +
      manifest.join('\n') + '\n'
  );

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const filename = `supabase-backup-${label}.zip`;
  const sizeMb = zipBuffer.length / (1024 * 1024);
  if (sizeMb > 24) {
    console.warn(
      `Backup zip is ${sizeMb.toFixed(2)} MB, which may exceed your email ` +
        `provider's attachment limit (~25 MB).`
    );
  }

  await sendBackupEmail({
    zipBuffer,
    filename,
    summaryText:
      `Schemas: ${schemas.join(', ')}\n` +
      `Tables backed up: ${tableCount}\n` +
      `Total rows: ${totalRows}`,
    dateLabel: label,
  });

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`Backup emailed: ${filename} (${sizeMb.toFixed(2)} MB) in ${elapsed.toFixed(1)}s`);

  return {
    ok: true,
    filename,
    tables: tableCount,
    totalRows,
    sizeMb: Number(sizeMb.toFixed(2)),
    elapsedSeconds: Number(elapsed.toFixed(1)),
  };
}

/** Convenience wrapper that opens its own connection (used by `npm run backup`). */
async function runBackupStandalone() {
  return withClient((client) => dumpAndEmail(client));
}

module.exports = { dumpAndEmail, runBackupStandalone, checkEmailEnv };
