-- 004_repairs.sql — repair_tokens (replaces n8n data table)
--
-- One row per house. parent_task_id is the canonical ClickUp parent that
-- holds all repair subtasks for the property. Owner email + language are
-- NOT stored here; they're fetched from muse-reviews by parent_task_id.
--
-- last_email_sent_at + last_email_type implement per-house cooldowns:
--   NewSubtask  -> 24h cooldown
--   Reminder    -> 72h cooldown

CREATE TABLE IF NOT EXISTS repair_tokens (
  parent_task_id      TEXT PRIMARY KEY,
  token               TEXT NOT NULL UNIQUE,
  app_number          INTEGER,
  last_email_sent_at  TEXT,
  last_email_type     TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repair_tokens_token ON repair_tokens(token);
