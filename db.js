// db.js — Cloudflare D1 HTTP client
// Uses Node 18+ built-in fetch. No new dependency.
//
// Only the /query endpoint is part of the D1 REST API. There is no /batch or /raw
// endpoint — those capabilities only exist on the Workers binding. For multi-row
// inserts we loop /query calls sequentially.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function endpoint() {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
}

function assertConfigured() {
  if (!ACCOUNT_ID || !DATABASE_ID || !API_TOKEN) {
    throw new Error('D1 not configured: set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN');
  }
}

async function callQuery(sql, params) {
  assertConfigured();
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params: params || [] })
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    const msg = json.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`D1 query failed: ${msg}`);
  }
  return json.result;
}

// Run a single statement. Returns the first result object { results, meta, success }.
async function query(sql, params = []) {
  const result = await callQuery(sql, params);
  return Array.isArray(result) ? result[0] : result;
}

// Run multiple statements sequentially. The REST API has no true batch endpoint,
// so this is not atomic — if a later statement fails the earlier ones are already
// committed. For inserting an order + its items that's acceptable: a partial write
// just leaves an order with fewer items, visible in the admin.
async function batch(statements) {
  const results = [];
  for (const s of statements) {
    results.push(await query(s.sql, s.params || []));
  }
  return results;
}

// Execute a SQL file containing multiple statements (for migrations).
// Splits on `;` at statement boundaries and runs each. Strips line comments.
async function exec(sqlText) {
  const stripped = sqlText.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  const statements = stripped
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const results = [];
  for (const s of statements) {
    results.push(await query(s));
  }
  return results;
}

function isConfigured() {
  return Boolean(ACCOUNT_ID && DATABASE_ID && API_TOKEN);
}

module.exports = { query, batch, exec, isConfigured };
