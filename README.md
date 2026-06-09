# Supabase Backup → Email

Automatically emails a CSV backup of **every table** in your Supabase project,
zipped, every **Monday at 8 AM Eastern**. Runs as a Netlify scheduled function —
no server to manage, no manual steps once deployed.

It connects to the **same Supabase project** as the Order Entry App, but uses the
Postgres connection string instead of the browser anon key, so it can read all
tables regardless of Row Level Security (which is what you want for a backup).

## What it does

1. Connects to your Supabase Postgres database.
2. Finds every base table in the `public` schema (configurable).
3. Dumps each table to a CSV file (one file per table).
4. Adds a `_manifest.txt` with row counts and a timestamp.
5. Zips everything into `supabase-backup-YYYY-MM-DD.zip`.
6. Emails the zip to you.

## Files

```
netlify/functions/supabase-backup.js   Scheduled job (Monday 8 AM ET)
netlify/functions/backup-now.js        On-demand trigger for testing (token-gated)
src/runBackup.js                       Core: connect, dump, zip, email
src/csv.js                             CSV serializer (RFC 4180)
src/email.js                           SMTP email via nodemailer
.env.example                           All environment variables, documented
netlify.toml                           Functions config (no site build)
```

## One-time setup

### 1. Create the repo and a new Netlify site
This is a **separate** Netlify site from the Order Entry App (like your Front
webhook). Push these files to a new GitHub repo and create a new Netlify site
from it. Because there's no build step, it deploys in seconds.

### 2. Get your Supabase connection string
Supabase dashboard → your project (the same one the Order Entry App uses) →
**Connect** → **Session pooler** → copy the URI and insert your database
password. Set it as `SUPABASE_DB_URL`.

### 3. Set up email (Gmail example)
Because you're emailing yourself, SMTP to your own inbox is simplest:
1. Make sure 2-Step Verification is on for your Google account.
2. Google Account → Security → **App passwords** → generate one.
3. Use it as `SMTP_PASS` (host `smtp.gmail.com`, port `465`,
   user = your Gmail address).

Any SMTP provider works (Outlook, Fastmail, a transactional service, etc.) —
just set the four `SMTP_*` variables accordingly.

### 4. Add environment variables in Netlify
Site settings → **Environment variables**. Add everything from `.env.example`
that isn't commented out:

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | yes | Session pooler connection string |
| `SMTP_HOST` | yes | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | yes | `465` (TLS) or `587` |
| `SMTP_USER` | yes | your email address |
| `SMTP_PASS` | yes | app password / SMTP password |
| `BACKUP_TO` | yes | where the backup is sent |
| `BACKUP_FROM` | no | defaults to `SMTP_USER` |
| `BACKUP_SCHEMAS` | no | defaults to `public` |
| `BACKUP_CRON` | no | defaults to `0 12 * * 1` |
| `BACKUP_TRIGGER_TOKEN` | no | enables the manual test endpoint |

Redeploy after adding variables so the function picks them up.

## Testing it now (don't wait until Monday)

Set `BACKUP_TRIGGER_TOKEN` to a long random string in Netlify, redeploy, then
visit:

```
https://YOUR-SITE.netlify.app/.netlify/functions/backup-now?token=YOUR_TOKEN
```

It runs the full backup immediately and returns a JSON summary. Check your
inbox for the zip. You can also trigger the scheduled function from the Netlify
dashboard (Functions → `supabase-backup` → run).

To test locally instead: `npm install`, copy `.env.example` to `.env`, fill it
in, then `npm run backup`.

## The schedule and Daylight Saving Time

Netlify cron runs in **UTC** and does not adjust for DST. The default
`0 12 * * 1` means Monday 12:00 UTC:
- **8:00 AM** during Eastern Daylight Time (mid-March → early November)
- **7:00 AM** during Eastern Standard Time (early November → mid-March)

For a weekly backup the exact hour is unimportant. If you'd rather it never
arrive before 8 AM, set `BACKUP_CRON=0 13 * * 1`.

## Notes & limits

- **Attachment size:** Gmail and most providers cap attachments around 25 MB.
  The function warns in the logs if the zip exceeds ~24 MB. CSVs compress well,
  so this is unlikely for typical internal tables, but if you outgrow it the
  natural next step is uploading the zip to storage (e.g. a Supabase Storage
  bucket or S3) and emailing a link instead.
- **CSV conventions:** SQL `NULL` is written as an empty unquoted field; an
  empty string is written as `""`; `json`/`jsonb`/array columns are
  JSON-encoded; `bytea` is hex (`\x...`); timestamps are ISO 8601. All other
  fields are double-quoted with internal quotes doubled (RFC 4180), so the
  files import cleanly into Excel, Google Sheets, or back into Postgres.
- **Views** are intentionally skipped (only base tables are backed up).
- One failing table won't abort the run — it's recorded in `_manifest.txt`
  and the rest still back up.
- Keep `SUPABASE_DB_URL` and `SMTP_PASS` in Netlify env vars only. Never commit
  `.env`.
