'use strict';

const { runBackup } = require('../../src/runBackup');

/*
 * This function is scheduled via netlify.toml:
 *   [functions."supabase-backup"]  schedule = "0 12 * * 1"
 *
 * Netlify cron runs in UTC and does NOT observe Daylight Saving Time.
 * "0 12 * * 1" = Monday 12:00 UTC = 8:00 AM EDT / 7:00 AM EST.
 * To change the time, edit the schedule in netlify.toml and push.
 * (Day-of-week 1 = Monday; 0 = Sunday.)
 */
exports.handler = async () => {
  try {
    const result = await runBackup();
    console.log('Scheduled backup complete:', JSON.stringify(result));
    return { statusCode: 200 };
  } catch (err) {
    console.error('Scheduled backup FAILED:', err.message);
    // Non-2xx marks the run as failed in Netlify's function logs.
    return { statusCode: 500, body: err.message };
  }
};
