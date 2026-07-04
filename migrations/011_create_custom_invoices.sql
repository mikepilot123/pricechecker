-- Custom invoices generated from a check-in ticket when staff check "Send
-- invoice to client". Each invoice is a frozen snapshot (payload jsonb) of
-- the ticket at send time, viewable by anyone with the unguessable token
-- (no PIN needed for the public GET view — that's the whole point, it's the
-- link handed to the customer).
CREATE TABLE IF NOT EXISTS custom_invoices (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  ticket_id TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  repair_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TTD',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_invoices_ticket ON custom_invoices (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_invoices_token ON custom_invoices (token);
