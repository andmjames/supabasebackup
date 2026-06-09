'use strict';

const { schedule } = require('@netlify/functions');
const { runBackup } = require('../../src/runBackup');

/*
 * Netlify cron runs in UTC and does NOT observe Daylight Saving Time.
 * Carmel/Indianapolis is Eastern time:
 *   - EDT (mid-Mar → early-Nov): 8:00 AM ET = 12:00 UTC  -> "0 12 * * 1"
 *   - EST (early-Nov → mid-Mar): 8:00 AM ET = 13:00 UTC  -> "0 13 * * 1"
 * We default to 12:00 UTC, so the backup lands at 8:00 AM during EDT and
 * 7:00 AM during EST. For a weekly backup the exact hour doesn't matter;
 * if you'd rather it never arrive before 8 AM, change "0 12" to "0 13".
 * (Day-of-week 1 = Monday; 0 = Sunday.)
 */
const CRON = process.env.BACKUP_CRON || '0 12 * * 1';

const handler = schedule(CRON, async () => {
  try {
    const result = await runBackup();
    console.log('Scheduled backup complete:', JSON.stringify(result));
  } catch (err) {
    // Throwing marks the function failed in Netlify logs so you get visibility.
    console.error('Scheduled backup FAILED:', err.message);
    throw err;
  }
  return { statusCode: 200 };
});

module.exports = { handler };
