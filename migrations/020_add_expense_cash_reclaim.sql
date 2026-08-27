-- Cash-reclaim expenses: money fronted in cash (often from the owner's other
-- business) that has to be collected back. The expense row holds the intent;
-- lib/expenses.js mirrors it into a "CASHBACK:<expense id>" reminder so it
-- shows up in the Reminders tab and the on-screen alert popups.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cash_reclaim BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaim_from TEXT NOT NULL DEFAULT '';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaim_due_at TIMESTAMPTZ;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_expenses_cash_reclaim
  ON expenses (deleted_at, cash_reclaim, reclaimed_at);

-- Reminders grow a machine-readable kind plus the money/expense they point at,
-- so the alert popup can render a "collect $X" card and tick the expense off.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2);
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS expense_id TEXT;
