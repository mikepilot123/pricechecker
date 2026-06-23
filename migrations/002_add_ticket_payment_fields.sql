-- Payment tracking for intake tickets. Both values are optional so older
-- tickets remain valid until staff add their financial details.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS repair_cost NUMERIC(12, 2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2);
