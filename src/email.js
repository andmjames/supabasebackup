'use strict';

const nodemailer = require('nodemailer');

/**
 * Build a nodemailer transport from environment variables.
 *
 * Required:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Optional:
 *   SMTP_SECURE  ("true" forces TLS-on-connect; defaults to true when port is 465)
 *
 * Gmail example:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=<16-char Google App Password>   (NOT your normal password)
 */
function buildTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const secure =
    process.env.SMTP_SECURE != null
      ? String(process.env.SMTP_SECURE).toLowerCase() === 'true'
      : port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

/**
 * Send the backup email with the zip attached.
 * @param {Object} opts
 * @param {Buffer} opts.zipBuffer
 * @param {string} opts.filename
 * @param {string} opts.summaryText  - plain-text body summary
 * @param {string} opts.dateLabel    - e.g. "2026-06-08"
 */
async function sendBackupEmail({ zipBuffer, filename, summaryText, dateLabel }) {
  const to = process.env.BACKUP_TO;
  const from = process.env.BACKUP_FROM || process.env.SMTP_USER;

  if (!to) throw new Error('BACKUP_TO is not set (the recipient email address).');

  const transport = buildTransport();

  const sizeMb = (zipBuffer.length / (1024 * 1024)).toFixed(2);

  const info = await transport.sendMail({
    from,
    to,
    subject: `Supabase backup — ${dateLabel}`,
    text:
      `Automated Supabase backup for ${dateLabel}.\n\n` +
      `${summaryText}\n\n` +
      `Attachment: ${filename} (${sizeMb} MB)\n`,
    attachments: [
      {
        filename,
        content: zipBuffer,
        contentType: 'application/zip',
      },
    ],
  });

  return info;
}

module.exports = { sendBackupEmail, buildTransport };
