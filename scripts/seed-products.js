#!/usr/bin/env node
// scripts/seed-products.js — populate the `products` table from public/catalog.json
// (external + muse tiers) plus a hardcoded internal-tier block that mirrors the
// PRODUCTS_BY_REGION constant in public/internal.html.
//
// Idempotent: re-running is safe because of the UNIQUE(tier, region, catalog_id)
// constraint and ON CONFLICT DO NOTHING. Existing rows (including any admin edits)
// are preserved; only missing rows get inserted.
//
// Usage: node scripts/seed-products.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../db');

// Mirror of PRODUCTS_BY_REGION in public/internal.html (lines 363–405).
// Kept here so the script doesn't have to parse JS out of the HTML file.
const INTERNAL_PRODUCTS_BY_REGION = {
  'Val Gardena': [
    { id: 1,  title: 'ASCIUGAMANO BAGNO 100x150',        description: '6 per Pacco',  price:  9.77 },
    { id: 2,  title: 'LENZUOLO C.ANG 2P DELUXE 200x210', description: '5 per Pacco',  price: 17.53 },
    { id: 3,  title: 'LENZUOLO C.ANG 1P DELUXE 100x210', description: '5 per Pacco',  price: 13.74 },
    { id: 4,  title: 'LENZUOLO 2P 240x300',              description: '10 per Pacco', price: 23.53 },
    { id: 5,  title: 'LENZUOLO 1P 160x300',              description: '10 per Pacco', price: 15.81 },
    { id: 6,  title: 'FEDERA GRANDE 60x80',              description: '25 per Pacco', price: 24.44 },
    { id: 7,  title: 'FEDERA PICCOLA 50x80',             description: '25 per Pacco', price: 22.55 },
    { id: 8,  title: 'COPRIPIUMINO 1P 135x200',          description: '10 per Pacco', price: 29.79 },
    { id: 9,  title: 'TOVAGLIA 150x150',                 description: '10 per Pacco', price: 24.68 },
    { id: 10, title: 'STROFINACCI PER BICCHIERI 50x70',  description: '25 per Pacco', price: 17.20 },
    { id: 11, title: 'SCENDIBAGNO 50x90',                description: '12 per Pacco', price: 15.08 },
    { id: 12, title: 'ASCIUGAMANO BIDET 40x60',          description: '20 per Pacco', price: 11.53 },
    { id: 13, title: 'ASCIUGAMANO VISO 50x100',          description: '12 per Pacco', price:  9.61 }
  ],
  'South Tyrol': [
    { id: 1,  title: 'ASCIUGAMANO BAGNO 100x150',        description: '6 per Pacco',  price:  9.77 },
    { id: 2,  title: 'LENZUOLO 2P 240x300',              description: '10 per Pacco', price: 23.53 },
    { id: 3,  title: 'LENZUOLO 1P 160x300',              description: '10 per Pacco', price: 15.81 },
    { id: 4,  title: 'FEDERA GRANDE 60x80',              description: '25 per Pacco', price: 24.44 },
    { id: 5,  title: 'FEDERA PICCOLA 50x80',             description: '25 per Pacco', price: 22.55 },
    { id: 6,  title: 'COPRIPIUMINO 1P 135x200',          description: '10 per Pacco', price: 29.79 },
    { id: 7,  title: 'TOVAGLIA 150x150',                 description: '10 per Pacco', price: 24.68 },
    { id: 8,  title: 'STROFINACCI PER BICCHIERI 50x70',  description: '25 per Pacco', price: 17.20 },
    { id: 9,  title: 'SCENDIBAGNO 50x90',                description: '12 per Pacco', price: 15.08 },
    { id: 10, title: 'ASCIUGAMANO BIDET 40x60',          description: '20 per Pacco', price: 11.53 },
    { id: 11, title: 'ASCIUGAMANO VISO 50x100',          description: '12 per Pacco', price:  9.61 }
  ],
  'Garda': [
    { id: 1,  title: 'ASCIUGAMANO BAGNO 100x150',        description: '6 per Pacco',  price:  9.77 },
    { id: 2,  title: 'LENZUOLO 2P 240x300',              description: '10 per Pacco', price: 23.53 },
    { id: 3,  title: 'LENZUOLO 1P 160x300',              description: '10 per Pacco', price: 15.81 },
    { id: 4,  title: 'FEDERA GRANDE 60x80',              description: '25 per Pacco', price: 24.44 },
    { id: 5,  title: 'FEDERA PICCOLA 50x80',             description: '25 per Pacco', price: 22.55 },
    { id: 6,  title: 'COPRIPIUMINO 1P 135x200',          description: '10 per Pacco', price: 29.79 },
    { id: 7,  title: 'TOVAGLIA 150x150',                 description: '10 per Pacco', price: 24.68 },
    { id: 8,  title: 'STROFINACCI PER BICCHIERI 50x70',  description: '25 per Pacco', price: 17.20 },
    { id: 9,  title: 'SCENDIBAGNO 50x90',                description: '12 per Pacco', price: 15.08 },
    { id: 10, title: 'ASCIUGAMANO BIDET 40x60',          description: '20 per Pacco', price: 11.53 },
    { id: 11, title: 'ASCIUGAMANO VISO 50x100',          description: '12 per Pacco', price:  9.61 }
  ]
};

async function main() {
  if (!db.isConfigured()) {
    console.error('Missing D1 env vars. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN in .env');
    process.exit(1);
  }

  const catalogPath = path.join(__dirname, '..', 'public', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const tiers = {
    external: catalog.external || {},
    muse:     catalog.muse     || {},
    internal: INTERNAL_PRODUCTS_BY_REGION
  };

  const now = Date.now();
  const sql = `INSERT INTO products
    (tier, region, catalog_id, title, description, price_cents, active, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(tier, region, catalog_id) DO NOTHING`;

  let inserted = 0, skipped = 0, total = 0;
  for (const [tier, regions] of Object.entries(tiers)) {
    for (const [region, items] of Object.entries(regions)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const priceCents = Math.round(Number(it.price) * 100);
        const result = await db.query(sql, [
          tier, region, it.id, it.title, it.description || null, priceCents, i, now
        ]);
        total++;
        // D1 returns meta.changes when a row is actually inserted.
        if (result && result.meta && result.meta.changes > 0) inserted++;
        else skipped++;
      }
    }
  }

  console.log(`Seed complete: ${inserted} inserted, ${skipped} already present, ${total} total.`);
  const counts = await db.query(
    `SELECT tier, COUNT(*) AS n FROM products GROUP BY tier ORDER BY tier`
  );
  console.log('\nRow counts by tier:');
  (counts.results || []).forEach(r => console.log(`  ${r.tier}: ${r.n}`));
}

main().catch(e => { console.error(e); process.exit(1); });
