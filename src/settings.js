'use strict';

// A single-row table holds the user-editable schedule + last-run status.
// It lives in the public schema, so it's also included in the backups itself.
const TABLE = 'backup_settings';

async function ensureSettings(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id            integer PRIMARY KEY DEFAULT 1,
       enabled       boolean NOT NULL DEFAULT true,
       day_of_week   integer NOT NULL DEFAULT 1,   -- 0=Sun .. 6=Sat (1=Mon)
       hour          integer NOT NULL DEFAULT 8,   -- 0..23, Eastern
       minute        integer NOT NULL DEFAULT 0,   -- 0/15/30/45, Eastern
       last_run_at   timestamptz,
       last_run_slot text,
       last_status   text,
       updated_at    timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT backup_settings_singleton CHECK (id = 1)
     )`
  );
  await client.query(`INSERT INTO ${TABLE} (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

async function getSettings(client) {
  const r = await client.query(`SELECT * FROM ${TABLE} WHERE id = 1`);
  return r.rows[0];
}

async function saveSettings(client, { enabled, day_of_week, hour, minute }) {
  const r = await client.query(
    `UPDATE ${TABLE}
        SET enabled = $1, day_of_week = $2, hour = $3, minute = $4, updated_at = now()
      WHERE id = 1
      RETURNING *`,
    [enabled, day_of_week, hour, minute]
  );
  return r.rows[0];
}

async function recordRun(client, { slot, status }) {
  await client.query(
    `UPDATE ${TABLE}
        SET last_run_at = now(), last_run_slot = $1, last_status = $2
      WHERE id = 1`,
    [slot, status]
  );
}

module.exports = { ensureSettings, getSettings, saveSettings, recordRun, TABLE };
