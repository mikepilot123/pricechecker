-- Zoho Books sync (lib/zoho.js). One row per invoice/expense sent to Zoho:
-- its Zoho id, what was last sent (hash + payments), and any failure to retry.
CREATE TABLE IF NOT EXISTS zoho_links (
  local_type       TEXT NOT NULL,              -- 'invoice' | 'expense'
  local_id         TEXT NOT NULL,
  zoho_id          TEXT,
  zoho_customer_id TEXT,
  label            TEXT NOT NULL DEFAULT '',
  synced_hash      TEXT NOT NULL DEFAULT '',
  paid_synced      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'syncing', -- syncing | synced | failed | warning | voided | deleted | skipped
  last_error       TEXT NOT NULL DEFAULT '',
  attempts         INTEGER NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (local_type, local_id)
);
CREATE INDEX IF NOT EXISTS idx_zoho_links_status ON zoho_links (status, updated_at);

-- Customer lookups already resolved to a Zoho contact (by email, phone or
-- name), so each invoice doesn't search Zoho again.
CREATE TABLE IF NOT EXISTS zoho_contacts (
  contact_key     TEXT PRIMARY KEY,
  zoho_contact_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
