-- Depositing cash into the bank is one real-world event recorded as two
-- ledger rows (a cash withdrawal, a bank deposit) so each side's balance
-- stays correct. This column links that pair so editing/deleting one side
-- can keep the other in sync instead of quietly going stale.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS transfer_id TEXT;
