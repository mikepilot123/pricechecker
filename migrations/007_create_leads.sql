-- Shared sales/repair leads pipeline. Leads are soft-deleted so the team can
-- hide dead records without losing historical context.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  issue TEXT NOT NULL DEFAULT '',
  quoted_amount NUMERIC(12, 2),
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'New',
  follow_up_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leads_deleted_status ON leads (deleted_at, status);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (follow_up_date);
CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads (updated_at DESC);
