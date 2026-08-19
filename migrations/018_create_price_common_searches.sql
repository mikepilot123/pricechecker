-- Shared automatic search tracking for the Prices tab.
-- Read by every device; deletes/renames require the team PIN via api/prices.js.

CREATE TABLE IF NOT EXISTS price_common_searches (
  id           TEXT PRIMARY KEY,
  query        TEXT NOT NULL,
  query_key    TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_price_common_searches_active
  ON price_common_searches (deleted_at, use_count DESC, last_used_at DESC, updated_at DESC);
