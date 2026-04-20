// src/db.js — thin wrapper around the Workers D1 binding.
// Keeps the same `query` / `batch` surface the old REST client exposed so the
// route handlers only need minimal changes.
//
// Unlike the old REST loop, D1.batch() is atomic: either all statements
// commit or none do.

export function makeDb(D1) {
  async function query(sql, params = []) {
    const stmt = D1.prepare(sql).bind(...params);
    const res = await stmt.all();
    // Match the old shape: { results, meta, success }
    return { results: res.results, meta: res.meta, success: res.success !== false };
  }

  async function batch(statements) {
    const prepared = statements.map(s => D1.prepare(s.sql).bind(...(s.params || [])));
    const results = await D1.batch(prepared);
    return results.map(r => ({ results: r.results, meta: r.meta, success: r.success !== false }));
  }

  return { query, batch, isConfigured: () => Boolean(D1) };
}
