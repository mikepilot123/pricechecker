-- One row per Prices search, with its time. price_common_searches keeps only
-- an all-time count per phrase; Smart restock needs "searched N times in the
-- last 30/60/90 days" to spot demand for parts. Kept for about a year.
CREATE TABLE IF NOT EXISTS price_search_events (
  id         BIGSERIAL PRIMARY KEY,
  query_key  TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_search_events_created ON price_search_events (created_at DESC);
