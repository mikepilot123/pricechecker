-- Tracks individual parts ordered from suppliers, one row per part. Flat and
-- denormalized (vendor/order date live on every row) rather than a normalized
-- orders+line-items split, matching how expenses/tickets are modeled
-- elsewhere in this app. batch_id groups rows that came from the same upload
-- (a PDF can contain several parts); customer/ticket linking happens per row
-- since one order confirmation can cover parts for more than one repair.
CREATE TABLE IF NOT EXISTS parts_orders (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL,
  vendor              TEXT NOT NULL DEFAULT '',
  part                TEXT NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1,
  unit_cost           NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'ordered',
  ordered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  arrived_at          TIMESTAMPTZ,
  customer_id         TEXT,
  customer_name       TEXT NOT NULL DEFAULT '',
  customer_phone      TEXT NOT NULL DEFAULT '',
  ticket_id           TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  source_document_url TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parts_orders_batch ON parts_orders (batch_id);
CREATE INDEX IF NOT EXISTS idx_parts_orders_customer ON parts_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_parts_orders_ticket ON parts_orders (ticket_id);
