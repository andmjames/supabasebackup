'use strict';

const { Client } = require('pg');

function dbCheck() {
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error(
      'SUPABASE_DB_URL is not set. Add it in Netlify → Site settings → Environment variables.'
    );
  }
}

/**
 * Open a Postgres client, run fn(client), and always close the connection.
 */
async function withClient(fn) {
  dbCheck();
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
    statement_timeout: 0,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

module.exports = { withClient, dbCheck };
