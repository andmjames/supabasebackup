'use strict';

const { withClient } = require('../../src/db');
const { ensureSettings, getSettings, recordRun } = require('../../src/settings');
const { dumpAndEmail } = require('../../src/runBackup');
const { easternParts } = require('../../src/easternTime');

/*
 * Lightweight poller. Scheduled in netlify.toml to fire every 15 minutes.
 * Netlify cron can't be changed at runtime, so instead of encoding the day/time
 * in the cron, we read it from the backup_settings table (edited via the UI) and
 * only run the actual backup when the current Eastern time matches.
 */
exports.handler = async () => {
  try {
    const result = await withClient(async (client) => {
      await ensureSettings(client);
      const cfg = await getSettings(client);

      if (!cfg.enabled) return { skipped: 'disabled' };

      const now = easternParts();
      const slot = Math.floor(now.minute / 15) * 15; // tolerate cron drift within the 15-min window
      const matches =
        now.dayOfWeek === cfg.day_of_week && now.hour === cfg.hour && slot === cfg.minute;
      if (!matches) return { skipped: 'not-scheduled' };

      const slotKey = `${now.dateStr} ${String(cfg.hour).padStart(2, '0')}:${String(cfg.minute).padStart(2, '0')}`;
      if (cfg.last_run_slot === slotKey) return { skipped: 'already-ran', slotKey };

      try {
        const summary = await dumpAndEmail(client);
        await recordRun(client, {
          slot: slotKey,
          status: `success: ${summary.tables} tables, ${summary.totalRows} rows, ${summary.sizeMb} MB`,
        });
        return { ran: true, summary };
      } catch (err) {
        await recordRun(client, { slot: slotKey, status: `error: ${err.message}` });
        throw err;
      }
    });

    console.log('Poll result:', JSON.stringify(result));
    return { statusCode: 200 };
  } catch (err) {
    console.error('Scheduled poll FAILED:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
