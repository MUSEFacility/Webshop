#!/usr/bin/env node
// scripts/sync-tokens-to-muse-reviews.mjs — one-time data migration.
// Reads every (parent_task_id, token) pair from D1.repair_tokens and PUTs
// the token into the matching muse-reviews property's repair_token field
// — but ONLY if the muse-reviews property currently has no repair_token
// (won't overwrite anything you already filled in via the Häuser tab).
//
// Run AFTER reviews#12 (Häuser email/token) is deployed to muse-reviews
// and BEFORE deploying the muse-webshop Worker switch in this PR. After
// the Worker swap, owners' magic links resolve via muse-reviews instead
// of D1; if a row hasn't been synced yet, that link 404s.
//
// Usage (PowerShell):
//   $env:APP_USER="..."; $env:APP_PASS="..."
//   node scripts/sync-tokens-to-muse-reviews.mjs           # dry run
//   node scripts/sync-tokens-to-muse-reviews.mjs --apply   # write
//
// Reads D1 via `wrangler d1 execute muse --remote --json --command`, so
// it has the same auth/permissions as your existing wrangler commands.

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const apply = process.argv.includes('--apply');
const base = process.env.MUSE_REVIEWS_BASE || 'https://muse-reviews.fly.dev';

if (!process.env.APP_USER || !process.env.APP_PASS) {
  console.error('Set $env:APP_USER and $env:APP_PASS first.');
  process.exit(1);
}

const auth = Buffer.from(`${process.env.APP_USER}:${process.env.APP_PASS}`).toString('base64');

console.log('Reading D1.repair_tokens...');
// Pipe the SQL via a temp .sql file rather than --command, to dodge
// PowerShell/cmd argument-splitting on the inline SQL string.
const tmp = mkdtempSync(join(tmpdir(), 'sync-tokens-'));
const sqlFile = join(tmp, 'q.sql');
writeFileSync(sqlFile, 'SELECT parent_task_id, token FROM repair_tokens;', 'utf-8');
let d1Out;
try {
  d1Out = execSync(
    `npx wrangler d1 execute muse --remote --json --file="${sqlFile}"`,
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'], shell: true },
  );
} finally {
  try { unlinkSync(sqlFile); } catch {}
}
// Wrangler v4 mixes progress markers (├, 🌀) with JSON on stdout even with
// --json. Strip everything before the first [ or { that begins a balanced
// JSON value — pragmatic, avoids any wrangler-version coupling.
function extractJson(s) {
  const firstArr = s.indexOf('\n[');
  const firstObj = s.indexOf('\n{');
  const candidates = [firstArr, firstObj].filter((i) => i >= 0);
  const start = candidates.length ? Math.min(...candidates) + 1 : (s.startsWith('[') || s.startsWith('{') ? 0 : -1);
  if (start < 0) throw new Error(`No JSON found in wrangler output:\n${s.slice(0, 500)}`);
  return s.slice(start).trim();
}
const d1Parsed = JSON.parse(extractJson(d1Out));
const d1Rows = Array.isArray(d1Parsed) ? d1Parsed[0]?.results ?? [] : d1Parsed.results ?? [];
console.log(`D1 rows: ${d1Rows.length}`);

const d1ByPid = new Map();
for (const row of d1Rows) {
  if (row.parent_task_id && row.token) d1ByPid.set(row.parent_task_id, row.token);
}
console.log(`D1 rows with token: ${d1ByPid.size}`);

console.log('Fetching muse-reviews properties...');
const res = await fetch(`${base}/api/reviews/properties`, {
  headers: { Authorization: `Basic ${auth}` },
});
if (!res.ok) {
  console.error(`GET /api/reviews/properties failed: HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const props = Array.isArray(data) ? data : data.properties || [];
console.log(`muse-reviews properties: ${props.length}`);

let matched = 0;
let alreadyHadToken = 0;
const willUpdate = [];
for (const p of props) {
  const pid = p.owner?.clickup?.parent_task_id;
  if (!pid) continue;
  const d1Token = d1ByPid.get(pid);
  if (!d1Token) continue;
  matched++;
  if (p.repair_token && p.repair_token.trim().length > 0) {
    alreadyHadToken++;
    if (p.repair_token !== d1Token) {
      console.log(`  ! ${p.id}: muse-reviews and D1 disagree (keeping muse-reviews)`);
    }
    continue;
  }
  willUpdate.push({ id: p.id, pid, newToken: d1Token, full: p });
}

console.log('---');
console.log('matched (D1 ↔ muse-reviews by pid):', matched);
console.log('  already had token in muse-reviews:', alreadyHadToken);
console.log('  empty repair_token — will sync:', willUpdate.length);
console.log('---');
if (willUpdate.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}
console.log('Sample syncs (first 5):');
willUpdate.slice(0, 5).forEach((u) =>
  console.log(`  ${u.id}  pid=${u.pid}  token=${u.newToken.slice(0, 16)}…`),
);

if (!apply) {
  console.log('\n(dry run — re-run with --apply to actually write)');
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const u of willUpdate) {
  const f = u.full;
  const payload = {
    id: f.id,
    display_name: f.display_name,
    default_language: f.default_language,
    ...(f.avantio_name_match ? { avantio_name_match: f.avantio_name_match } : {}),
    ...(f.avantio_name_patterns ? { avantio_name_patterns: f.avantio_name_patterns } : {}),
    ...(f.caretaker ? { caretaker: f.caretaker } : {}),
    owner: f.owner,
    repair_token: u.newToken,
  };
  const r = await fetch(`${base}/api/properties/${encodeURIComponent(u.id)}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.ok) {
    ok++;
    console.log(`  ✓ ${u.id} <- ${u.newToken.slice(0, 16)}…`);
  } else {
    fail++;
    const txt = await r.text().catch(() => '');
    console.log(`  ✗ ${u.id}: HTTP ${r.status} ${txt.slice(0, 120)}`);
  }
}
console.log(`---\ndone: ok=${ok} fail=${fail}`);
