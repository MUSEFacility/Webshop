// db.js — Cloudflare D1 HTTP client
// Uses Node 18+ built-in fetch. No new dependency.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function endpoint(path) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/${path}`;
}

function assertConfigured() {
  if (!ACCOUNT_ID || !DATABASE_ID || !API_TOKEN) {
    throw new Error('D1 not configured: set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN');
  }
}

async function callD1(path, body) {
  assertConfigured();
  const res = await fetch(endpoint(path), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    const msg = json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`D1 ${path} failed: ${msg}`);
  }
  return json.result;
}

// Run a single statement. Returns { results, meta, success } from D1.
async function query(sql, params = []) {
  const result = await callD1('query', { sql, params });
  return Array.isArray(result) ? result[0] : result;
}

// Run a batch of statements in one round-trip (atomic within the batch).
// statements: [{ sql, params }, ...]
async function batch(statements) {
  return await callD1('batch', statements);
}

// Execute raw SQL containing multiple statements (for migrations).
async function exec(sqlText) {
  assertConfigured();
  const res = await fetch(endpoint('raw'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql: sqlText })
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    const msg = json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`D1 exec failed: ${msg}`);
  }
  return json.result;
}

function isConfigured() {
  return Boolean(ACCOUNT_ID && DATABASE_ID && API_TOKEN);
}

module.exports = { query, batch, exec, isConfigured };
