-- 003_products.sql — DB-backed catalog (replaces public/catalog.json + internal.html PRODUCTS_BY_REGION)

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tier            TEXT NOT NULL,
  region          TEXT NOT NULL,
  catalog_id      INTEGER NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  price_cents     INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  UNIQUE(tier, region, catalog_id)
);

CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(tier, region, active, sort_order);
