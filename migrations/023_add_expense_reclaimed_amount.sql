-- Partial cash collection. Before this, a cash-reclaim expense was all-or-
-- nothing: reclaimed_at set meant the whole amount came back, null meant none
-- of it had. In practice the other business pays some of it now and the rest
-- later, so track how much has actually been handed over.
--
-- reclaimed_amount is the running total collected so far; the outstanding
-- balance is amount - reclaimed_amount. reclaimed_at stays the "fully settled"
-- marker and is set by lib/expenses.js once reclaimed_amount reaches amount,
-- so every existing reader (the reminder mirror, the Reminders tab, the alert
-- popups) keeps working unchanged.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaimed_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Anything already marked collected was collected in full, by definition of
-- the old two-state model.
UPDATE expenses
SET reclaimed_amount = amount
WHERE reclaimed_at IS NOT NULL AND reclaimed_amount = 0;
