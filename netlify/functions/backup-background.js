// netlify/functions/backup-background.js
//
// Netlify BACKGROUND function. Dumps every table in the public schema to CSV,
// zips them, uploads the zip to a private Supabase Storage bucket, and emails
// a download LINK (not an attachment) — so it never hits Gmail's 25 MB cap.
//
// Memory-safe: each table is written to a file in /tmp and the zip is streamed
// from disk, so memory stays flat regardless of database size.
//
// No new dependencies (jszip is already in this project; pg + nodemailer too).
//
// Environment variables required (in Netlify):
//   SUPABASE_DB_URL              - Postgres connection string (already set)
//   SUPABASE_URL                 - e.g. https://zhvfcipveeeybczzmues.supabase.co   (NEW)
//   SUPABASE_SERVICE_ROLE_KEY    - Supabase service_role secret key                (NEW)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, BACKUP_TO   (already set)
//   BACKUP_TRIGGER_TOKEN         - gate for the trigger (already set)

const { Client } = require("pg");
const JSZip = require("jszip");
const nodemailer = require("nodemailer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BUCKET = "db-backups";
const LINK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const KEEP_BACKUPS = 12;                     // prune older zips beyond this many

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (Buffer.isBuffer(v)) s = "\\x" + v.toString("hex");
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function easternDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  const qs = event.queryStringParameters || {};
  const token = headers["x-backup-token"] || qs.token;
  if (process.env.BACKUP_TRIGGER_TOKEN && token !== process.env.BACKUP_TRIGGER_TOKEN) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("backup failed: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var");
    return { statusCode: 500, body: "backup failed: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const { rows: tables } = await client.query(
      `select tablename from pg_catalog.pg_tables
        where schemaname = 'public' order by tablename`
    );

    let totalRows = 0;
    const zip = new JSZip();

    for (const { tablename } of tables) {
      const res = await client.query(`select * from "public"."${tablename.replace(/"/g, '""')}"`);
      const cols = res.fields.map((f) => f.name);
      const filePath = path.join(tmp, `${tablename}.csv`);
      const ws = fs.createWriteStream(filePath);

      const writeLine = (line) =>
        ws.write(line) ? Promise.resolve() : new Promise((r) => ws.once("drain", r));

      await writeLine(cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(",") + "\r\n");
      for (const row of res.rows) {
        await writeLine(cols.map((c) => csvField(row[c])).join(",") + "\r\n");
      }
      await new Promise((resolve, reject) => {
        ws.on("error", reject);
        ws.end(resolve);
      });

      zip.file(`${tablename}.csv`, fs.createReadStream(filePath));
      totalRows += res.rows.length;
    }

    await client.end();

    // Build the zip on disk (memory stays flat).
    const zipPath = path.join(tmp, "backup.zip");
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      out.on("finish", resolve);
      out.on("error", reject);
      zip
        .generateNodeStream({
          type: "nodebuffer",
          streamFiles: true,
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        })
        .on("error", reject)
        .pipe(out);
    });

    const bytes = fs.statSync(zipPath).size;
    const sizeMb = (bytes / (1024 * 1024)).toFixed(1);
    const date = easternDate();
    const objectName = `backup-${date}.zip`;

    // Upload the zip to the private Storage bucket (upsert overwrites same-day reruns).
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/zip",
        "x-upsert": "true",
      },
      body: fs.readFileSync(zipPath),
    });
    if (!uploadRes.ok) {
      throw new Error(`storage upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }

    // Create a signed download link.
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${objectName}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: LINK_TTL_SECONDS }),
    });
    if (!signRes.ok) {
      throw new Error(`signing link failed: ${signRes.status} ${await signRes.text()}`);
    }
    const link = `${SUPABASE_URL}/storage/v1${(await signRes.json()).signedURL}`;

    // Best-effort prune of older backups so Storage doesn't grow forever.
    try {
      const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }),
      });
      if (listRes.ok) {
        const items = (await listRes.json()) || [];
        const zips = items
          .map((o) => o.name)
          .filter((n) => /^backup-\d{4}-\d{2}-\d{2}\.zip$/.test(n))
          .sort();
        const stale = zips.slice(0, Math.max(0, zips.length - KEEP_BACKUPS));
        for (const name of stale) {
          await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${SERVICE_KEY}` },
          });
        }
      }
    } catch (e) {
      console.warn("prune skipped:", e.message);
    }

    // Email the link (no attachment).
    const port = Number(process.env.SMTP_PORT) || 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.BACKUP_TO,
      subject: `Supabase backup — ${date}`,
      text:
        `Your Supabase backup is ready.\n\n` +
        `${tables.length} tables, ${totalRows} rows, ${sizeMb} MB.\n\n` +
        `Download (link valid 30 days):\n${link}\n`,
    });

    console.log(`done: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB, uploaded ${objectName}`);
    return { statusCode: 200, body: `done: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB` };
  } catch (err) {
    console.error("backup failed:", err);
    return { statusCode: 500, body: "backup failed: " + err.message };
  } finally {
    try { await client.end(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
};
