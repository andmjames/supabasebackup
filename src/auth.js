'use strict';

/*
 * Shared token gate for the HTTP-triggered functions (backup-now, backup-config).
 * Looks for the token in the `x-backup-token` header or a `token` query param.
 * If BACKUP_TRIGGER_TOKEN is unset, the endpoints are disabled (404).
 */
function authorize(event) {
  const expected = process.env.BACKUP_TRIGGER_TOKEN;
  if (!expected) return { ok: false, code: 404, message: 'Not found' };

  const headers = event.headers || {};
  const provided =
    headers['x-backup-token'] ||
    headers['X-Backup-Token'] ||
    (event.queryStringParameters && event.queryStringParameters.token);

  if (provided !== expected) return { ok: false, code: 401, message: 'Unauthorized' };
  return { ok: true };
}

module.exports = { authorize };
