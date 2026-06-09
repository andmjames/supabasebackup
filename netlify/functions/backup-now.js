'use strict';

const { withClient } = require('../../src/db');
const { ensureSettings, recordRun } = require('../../src/settings');
const { dumpAndEmail } = require('../../src/runBackup');
const { easternParts } = require('../../src/easternTime');
const { authorize } = require('../../src/auth');

/*
 * On-demand backup, triggered by the UI's "Back up now" button.
 * Runs immediately regardless of schedule. Token-gated.
 */
exports.handler = async (event) => {
  const auth = authorize(event);
  if (!auth.ok) return { statusCode: auth.code, body: auth.message };

  try {
    const result = await withClient(async (client) => {
      await ensureSettings(client);
      const summary = await dumpAndEmail(client);
      const now = easternParts();
      await recordRun(client, {
        slot: `manual ${now.dateStr} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
        status: `success (manual): ${summary.tables} tables, ${summary.totalRows} rows, ${summary.sizeMb} MB`,
      });
      return summary;
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Manual backup FAILED:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
