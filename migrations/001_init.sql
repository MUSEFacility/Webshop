-- 001_init.sql — orders, order_items, cleaning_quotes

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  region          TEXT NOT NULL,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  total_cents     INTEGER NOT NULL,
  item_count      INTEGER NOT NULL,
  source          TEXT NOT NULL DEFAULT 'external'
);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_region  ON orders(region);
CREATE INDEX IF NOT EXISTS idx_orders_email   ON orders(customer_email);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          TEXT NOT NULL REFERENCES orders(id),
  product_id        TEXT NOT NULL,
  product_title     TEXT NOT NULL,
  qty               INTEGER NOT NULL,
  unit_price_cents  INTEGER NOT NULL,
  line_total_cents  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS cleaning_quotes (
  id                  TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  region              TEXT NOT NULL,
  requester_name      TEXT NOT NULL,
  requester_email     TEXT NOT NULL,
  apartment_id        TEXT NOT NULL,
  requested_date      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  quoted_price_cents  INTEGER,
  decided_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_quotes_created ON cleaning_quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_status  ON cleaning_quotes(status);
