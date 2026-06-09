'use strict';

const { withClient } = require('../../src/db');
const { ensureSettings, getSettings, saveSettings } = require('../../src/settings');
const { authorize } = require('../../src/auth');

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < min || n > max) return null;
  return n;
}

/*
 * Read (GET) or update (POST) the backup schedule. Token-gated.
 * POST body: { enabled:boolean, day_of_week:0-6, hour:0-23, minute:0|15|30|45 }
 */
exports.handler = async (event) => {
  const auth = authorize(event);
  if (!auth.ok) return { statusCode: auth.code, body: auth.message };

  try {
    if (event.httpMethod === 'GET') {
      const cfg = await withClient(async (c) => {
        await ensureSettings(c);
        return getSettings(c);
      });
      return json(200, cfg);
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return json(400, { error: 'Invalid JSON body.' });
      }
      const day_of_week = clampInt(body.day_of_week, 0, 6);
      const hour = clampInt(body.hour, 0, 23);
      const minute = [0, 15, 30, 45].includes(parseInt(body.minute, 10)) ? parseInt(body.minute, 10) : null;
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;

      if (day_of_week === null || hour === null || minute === null || enabled === null) {
        return json(400, {
          error: 'Provide enabled (boolean), day_of_week (0-6), hour (0-23), minute (0/15/30/45).',
        });
      }

      const cfg = await withClient(async (c) => {
        await ensureSettings(c);
        return saveSettings(c, { enabled, day_of_week, hour, minute });
      });
      return json(200, cfg);
    }

    return { statusCode: 405, body: 'Method not allowed' };
  } catch (err) {
    console.error('config error:', err.message);
    return json(500, { error: err.message });
  }
};
