'use strict';

const { Client } = require('pg');
const JSZip = require('jszip');
const { buildCsv } = require('./csv');
const { sendBackupEmail } = require('./email');

/** Throw early with a clear message if required env vars are missing. */
function checkEnv() {
  const required = ['SUPABASE_DB_URL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'BACKUP_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set these in your Netlify site (Site settings → Environment variables).`
    );
  }
}

/** Safely double-quote a Postgres identifier. */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Local date label in America/Indiana/Indianapolis (Eastern). */
function dateLabel() {
  // en-CA gives YYYY-MM-DD; tie it to Eastern so the filename matches "your" Monday.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indiana/Indianapolis',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Run a full backup: dump every base table in the configured schema(s) to CSV,
 * zip them, and email the zip. Returns a summary object.
 */
async function runBackup() {
  checkEnv();

  const schemas = (process.env.BACKUP_SCHEMAS || 'public')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
    // Give long-running dumps room; Netlify functions still cap overall runtime.
    statement_timeout: 0,
  });

  const startedAt = Date.now();
  const zip = new JSZip();
  const manifest = [];
  let totalRows = 0;

  await client.connect();
  try {
    // Discover base tables (pg_tables excludes views & materialized views).
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
        const csv = buildCsv(res.fields, res.rows);
        zip.file(`${fqName}.csv`, csv);
        manifest.push(`${fqName}: ${res.rows.length} rows`);
        totalRows += res.rows.length;
        console.log(`Dumped ${fqName} (${res.rows.length} rows)`);
      } catch (tableErr) {
        // Don't let one bad table abort the whole backup; record and continue.
        const msg = `${fqName}: ERROR — ${tableErr.message}`;
        manifest.push(msg);
        console.error(msg);
      }
    }

    const label = dateLabel();
    const tableCount = tablesRes.rows.length;

    // Add a human-readable manifest to the archive.
    const manifestText =
      `Supabase backup\n` +
      `Generated: ${new Date().toISOString()} (UTC)\n` +
      `Date label: ${label} (Eastern)\n` +
      `Schemas: ${schemas.join(', ')}\n` +
      `Tables: ${tableCount}\n` +
      `Total rows: ${totalRows}\n\n` +
      manifest.join('\n') + '\n';
    zip.file('_manifest.txt', manifestText);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const filename = `supabase-backup-${label}.zip`;
    const sizeMb = zipBuffer.length / (1024 * 1024);

    // Gmail (and most providers) cap attachments around 25 MB.
    if (sizeMb > 24) {
      console.warn(
        `Backup zip is ${sizeMb.toFixed(2)} MB, which may exceed your email ` +
          `provider's attachment limit (~25 MB). Consider uploading to storage instead.`
      );
    }

    const summaryText =
      `Schemas: ${schemas.join(', ')}\n` +
      `Tables backed up: ${tableCount}\n` +
      `Total rows: ${totalRows}`;

    await sendBackupEmail({ zipBuffer, filename, summaryText, dateLabel: label });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Backup emailed: ${filename} (${sizeMb.toFixed(2)} MB) in ${elapsed}s`);

    return {
      ok: true,
      filename,
      tables: tableCount,
      totalRows,
      sizeMb: Number(sizeMb.toFixed(2)),
      elapsedSeconds: Number(elapsed),
    };
  } finally {
    await client.end();
  }
}

module.exports = { runBackup, checkEnv };
