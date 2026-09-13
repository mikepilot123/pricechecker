ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS expense_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_expense
  ON bank_transactions (expense_id)
  WHERE expense_id IS NOT NULL;
