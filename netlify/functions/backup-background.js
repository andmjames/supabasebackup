// netlify/functions/backup-background.js
//
// Netlify BACKGROUND function. Dumps every table in the public schema to CSV,
// zips them, and emails the zip.
//
// Memory-safe: each table is written to a file in /tmp, and the zip is built
// by streaming those files from disk — nothing holds the whole database in
// memory, so it won't hit Netlify's 1 GB ceiling as the data grows.
//
// No new dependencies. Uses jszip (already in this project), plus pg and
// nodemailer, and the same env vars you already have set:
//   SUPABASE_DB_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, BACKUP_TO,
//   BACKUP_TRIGGER_TOKEN

const { Client } = require("pg");
const JSZip = require("jszip");
const nodemailer = require("nodemailer");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

    // Dump each table to its own file on disk, released before the next table.
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

      // Add the file to the zip as a stream — its contents stay on disk until
      // the zip is generated, so memory doesn't balloon.
      zip.file(`${tablename}.csv`, fs.createReadStream(filePath));
      totalRows += res.rows.length;
    }

    await client.end();

    // Generate the zip as a stream to disk (streamFiles keeps memory flat).
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

    const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);

    const port = Number(process.env.SMTP_PORT) || 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const date = easternDate();
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.BACKUP_TO,
      subject: `Supabase backup — ${date}`,
      text: `Backup complete: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB.`,
      attachments: [{ filename: `supabase-backup-${date}.zip`, path: zipPath }],
    });

    console.log(`done: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB`);
    return { statusCode: 200, body: `done: ${tables.length} tables, ${totalRows} rows, ${sizeMb} MB` };
  } catch (err) {
    console.error("backup failed:", err);
    return { statusCode: 500, body: "backup failed: " + err.message };
  } finally {
    try { await client.end(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
};
