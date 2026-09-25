-- Deleting an invoice in the app hides it (list, repair lookup, customer
-- link) but keeps the row, so a mistaken delete can be recovered.
ALTER TABLE custom_invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
