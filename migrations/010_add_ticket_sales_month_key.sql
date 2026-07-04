-- Pins the month a ticket was first marked "Picked Up" (completed), so the
-- monthly_sales ledger always credits/adjusts the right month even if a
-- repair-cost correction happens much later. See lib/tickets.js's "Monthly
-- sales ledger" comment for the full design — revenue is recognized only
-- for tickets that reach "Picked Up", matching the Completed Repairs tab,
-- not at intake.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sales_month_key TEXT;
