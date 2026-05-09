#!/usr/bin/env node
// scripts/backfill-owner-emails.mjs — one-time data migration.
// Reads repair_tokens.csv (n8n export), matches each row to a muse-reviews
// property by parent_task_id, and writes the n8n `mail` value into the
// muse-reviews property's owner.email — but ONLY when the muse-reviews
// record currently has an empty owner.email (won't overwrite anything you
// already filled in via the Häuser tab).
//
// Usage (PowerShell):
//   $env:APP_USER="..."; $env:APP_PASS="..."
//   node scripts/backfill-owner-emails.mjs repair_tokens.csv          # dry run
//   node scripts/backfill-owner-emails.mjs repair_tokens.csv --apply  # write

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const base = process.env.MUSE_REVIEWS_BASE || 'https://muse-reviews.fly.dev';

if (!csvPath) {
  console.error('usage: node scripts/backfill-owner-emails.mjs <csv> [--apply]');
  process.exit(1);
}
if (!process.env.APP_USER || !process.env.APP_PASS) {
  console.error('Set $env:APP_USER and $env:APP_PASS first.');
  process.exit(1);
}

const auth = Buffer.from(`${process.env.APP_USER}:${process.env.APP_PASS}`).toString('base64');

function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') q = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const raw = readFileSync(resolve(csvPath), 'utf-8').replace(/^﻿/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const header = splitCsv(lines[0]).map((h) => h.trim());
const piIdx = header.indexOf('parentTaskId');
const mailIdx = header.indexOf('mail');
if (piIdx < 0 || mailIdx < 0) {
  console.error('CSV missing parentTaskId or mail column.');
  process.exit(1);
}

const csvByPid = new Map();
for (let i = 1; i < lines.length; i++) {
  const c = splitCsv(lines[i]);
  const pid = (c[piIdx] || '').trim();
  const mail = (c[mailIdx] || '').trim();
  if (pid && mail) csvByPid.set(pid, mail);
}
console.log(`CSV rows with parentTaskId + mail: ${csvByPid.size}`);

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
let alreadyHadEmail = 0;
const willUpdate = [];
for (const p of props) {
  const pid = p.owner?.clickup?.parent_task_id;
  if (!pid) continue;
  const csvMail = csvByPid.get(pid);
  if (!csvMail) continue;
  matched++;
  const cur = (p.owner?.email || '').trim();
  if (cur.length > 0) { alreadyHadEmail++; continue; }
  willUpdate.push({ id: p.id, pid, newEmail: csvMail, full: p });
}

console.log('---');
console.log('matched (csv ↔ muse-reviews by pid):', matched);
console.log('  already had email — skipping:', alreadyHadEmail);
console.log('  empty email — will update:', willUpdate.length);
console.log('---');
console.log('Sample updates (first 8):');
willUpdate.slice(0, 8).forEach((u) => console.log(`  ${u.id}  ->  ${u.newEmail}`));

if (!apply) {
  console.log('\n(dry run — re-run with --apply to actually write)');
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const u of willUpdate) {
  // Build a clean PropertyConfig payload — strip review-aggregate fields
  // returned by /api/reviews/properties that the PUT handler doesn't accept.
  const f = u.full;
  const payload = {
    id: f.id,
    display_name: f.display_name,
    default_language: f.default_language,
    ...(f.avantio_name_match ? { avantio_name_match: f.avantio_name_match } : {}),
    ...(f.avantio_name_patterns ? { avantio_name_patterns: f.avantio_name_patterns } : {}),
    ...(f.caretaker ? { caretaker: f.caretaker } : {}),
    owner: { ...f.owner, email: u.newEmail },
  };
  const r = await fetch(`${base}/api/properties/${encodeURIComponent(u.id)}`, {
    method: 'PUT',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.ok) {
    ok++;
    console.log(`  ✓ ${u.id} <- ${u.newEmail}`);
  } else {
    fail++;
    const txt = await r.text().catch(() => '');
    console.log(`  ✗ ${u.id}: HTTP ${r.status} ${txt.slice(0, 120)}`);
  }
}
console.log(`---\ndone: ok=${ok} fail=${fail}`);
