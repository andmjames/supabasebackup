// netlify/functions/backup-background.js
//
// Netlify BACKGROUND function (the "-background" suffix is required — it gives
// this a 15-minute runtime and a callable URL). Dumps every table in the
// public schema to CSV, zips them, and emails the zip.
//
// Drop this file into your existing supabase-backup project at
//   netlify/functions/backup-background.js
// and redeploy. It uses the same env vars you already have in Netlify:
//   SUPABASE_DB_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, BACKUP_TO,
//   BACKUP_TRIGGER_TOKEN
//
// After deploy it lives at:
//   https://<your-site>.netlify.app/.netlify/functions/backup-background
//
// Trigger it with the token, e.g.:
//   curl -X POST -H "x-backup-token: <BACKUP_TRIGGER_TOKEN>" \
//        https://<your-site>.netlify.app/.netlify/functions/backup-background

const { Client } = require("pg");
const JSZip = require("jszip");
const nodemailer = require("nodemailer");

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

    const zip = new JSZip();
    let totalRows = 0;

    for (const { tablename } of tables) {
      const res = await client.query(`select * from "public"."${tablename.replace(/"/g, '""')}"`);
      const cols = res.fields.map((f) => f.name);
      const header = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(",");
      let csv = header + "\r\n";
      for (const row of res.rows) {
        csv += cols.map((c) => csvField(row[c])).join(",") + "\r\n";
      }
      zip.file(`${tablename}.csv`, csv);
      totalRows += res.rows.length;
    }

    const content = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const port = Number(process.env.SMTP_PORT) || 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const date = easternDate();
    const sizeMb = (content.length / (1024 * 1024)).toFixed(1);
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.BACKUP_TO,
      subject: `Supabase backup — ${date}`,
      text: `Backup complete: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB.`,
      attachments: [{ filename: `supabase-backup-${date}.zip`, content }],
    });

    return { statusCode: 200, body: `done: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB` };
  } catch (err) {
    console.error("backup failed:", err);
    return { statusCode: 500, body: "backup failed: " + err.message };
  } finally {
    try { await client.end(); } catch (_) {}
  }
};
