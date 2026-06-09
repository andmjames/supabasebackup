# Supabase Backup → Email (with web UI)

Emails a zipped CSV backup of **every table** in your Supabase project, on a
schedule you control from a small web UI. Runs entirely on Netlify Functions —
no server to manage.

It connects to the **same Supabase project** as the Order Entry App, using the
Postgres connection string (not the browser anon key), so it can read every
table regardless of Row Level Security.

## What you get

- **Back up now** — a button that runs the backup immediately and emails the zip.
- **Schedule editor** — pick the day and time (Eastern); it's honored to the
  quarter-hour, with daylight saving handled automatically. Toggle it on/off.
- **Status** — shows when the last backup ran and whether it succeeded.

## How the schedule works

Netlify can't change a function's cron at runtime, so the scheduled function
runs every 15 minutes as a lightweight **poller**: it reads the day/time you
saved (stored in a `backup_settings` table) and only runs the actual backup when
the current Eastern time matches. Changing the schedule in the UI just updates
that row — no redeploy needed.

The `backup_settings` table is created automatically on first run (a single row).
It lives in `public`, so it's included in the backups too.

## Files

```
public/index.html                      The web UI (run now + schedule editor)
netlify/functions/supabase-backup.js   Poller: every 15 min, runs backup when due
netlify/functions/backup-now.js        On-demand backup (UI "Back up now")
netlify/functions/backup-config.js     Read/update the schedule (UI)
src/runBackup.js                        Core: dump tables → CSV → zip → email
src/settings.js                         The backup_settings table (schedule + status)
src/db.js                              Postgres connection helper
src/email.js                           SMTP email via nodemailer
src/csv.js                             CSV serializer (RFC 4180)
src/easternTime.js                     Eastern-time helper for scheduling
src/auth.js                            Shared token gate for the HTTP endpoints
```

## One-time setup

### 1. Create the repo and a new Netlify site
This is a **separate** Netlify site from the Order Entry App. Push these files to
a new GitHub repo and create a Netlify site from it. There's no build step, so it
deploys in seconds.

### 2. Environment variables (Netlify → Site settings → Environment variables)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | yes | Session pooler connection string (same project as Order Entry) |
| `SMTP_HOST` | yes | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | yes | `465` (TLS) or `587` |
| `SMTP_USER` | yes | your email address |
| `SMTP_PASS` | yes | app password / SMTP password |
| `BACKUP_TO` | yes | where the backup is sent |
| `BACKUP_TRIGGER_TOKEN` | **yes (for the UI)** | the password the UI uses to call the backup/config endpoints; without it the UI can't do anything |
| `BACKUP_FROM` | no | defaults to `SMTP_USER` |
| `BACKUP_SCHEMAS` | no | defaults to `public` |

See `.env.example` for where to find each value (Supabase connection string,
Gmail app password, etc.). Redeploy after adding variables.

### 3. Use the UI
Open your site's URL (e.g. `https://YOUR-SITE.netlify.app`). Enter your
`BACKUP_TRIGGER_TOKEN`, click **Remember on this device**, then:
- **Run backup & email it** to back up right now, or
- set the **day and time** and **Save schedule**.

The token is stored only in your browser (localStorage) for convenience; the real
security is the token check on the server endpoints.

## The poll cadence (netlify.toml)

`netlify.toml` schedules the poller at `0,15,30,45 * * * *` (every 15 minutes).
That's just how often it *checks* — the actual day/time comes from the UI. You
shouldn't need to touch the cron.

## Notes & limits

- **Function timeout:** the "Back up now" endpoint runs synchronously, so a very
  large database could exceed Netlify's function timeout (~10s by default). If you
  hit that, raise the timeout in Netlify's function settings, or convert the
  backup to a background function. For typical internal tables it finishes in a
  few seconds.
- **Attachment size:** most email providers cap attachments around 25 MB. The
  function warns in the logs above ~24 MB. If you outgrow it, upload the zip to a
  storage bucket and email a link instead.
- **CSV conventions:** SQL `NULL` → empty unquoted field; empty string → `""`;
  `json`/`jsonb`/arrays → JSON-encoded; `bytea` → hex (`\x…`); timestamps → ISO
  8601; everything else double-quoted (RFC 4180). Imports cleanly into Excel,
  Sheets, or back into Postgres.
- **Views** are skipped (base tables only). One failing table won't abort the run.
- Keep `SUPABASE_DB_URL`, `SMTP_PASS`, and `BACKUP_TRIGGER_TOKEN` in Netlify env
  vars only. Never commit `.env`.
