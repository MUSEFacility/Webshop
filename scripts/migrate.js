#!/usr/bin/env node
// scripts/migrate.js — apply all SQL files in migrations/ to D1 in order.
// Usage: node scripts/migrate.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function main() {
  if (!db.isConfigured()) {
    console.error('Missing D1 env vars. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN in .env');
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    try {
      await db.exec(sql);
      console.log('ok');
    } catch (e) {
      console.error('FAILED');
      console.error(e.message);
      process.exit(1);
    }
  }

  const tables = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  console.log('\nTables in D1:');
  (tables.results || []).forEach(r => console.log('  - ' + r.name));
}

main().catch(e => { console.error(e); process.exit(1); });
