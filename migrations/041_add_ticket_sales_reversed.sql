-- Deleting a single picked-up repair takes its sale back off the
-- monthly_sales ledger (it was logged by mistake, or was a test — not a real
-- sale). This flag records that the credit was reversed, so restoring the
-- repair from a backup knows to credit it again, and rebuildMonthlySales()
-- leaves it out. "Clear all" is an archive, not a correction, so it never
-- sets this flag and those sales stay in the history.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sales_reversed BOOLEAN NOT NULL DEFAULT FALSE;
