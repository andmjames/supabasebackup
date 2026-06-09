'use strict';

const { runBackup } = require('../../src/runBackup');

/*
 * On-demand trigger for testing, so you don't have to wait until Monday.
 * Protected by a shared secret. Set BACKUP_TRIGGER_TOKEN in Netlify, then call:
 *   https://YOUR-SITE.netlify.app/.netlify/functions/backup-now?token=YOUR_TOKEN
 * If BACKUP_TRIGGER_TOKEN is unset, this endpoint is disabled.
 */
exports.handler = async (event) => {
  const expected = process.env.BACKUP_TRIGGER_TOKEN;
  if (!expected) {
    return { statusCode: 404, body: 'Not found' };
  }

  const provided =
    (event.queryStringParameters && event.queryStringParameters.token) ||
    (event.headers && event.headers['x-backup-token']);

  if (provided !== expected) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    const result = await runBackup();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Manual backup FAILED:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
