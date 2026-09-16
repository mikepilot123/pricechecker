-- Cash on hand is tracked in the same bank_transactions ledger, distinguished
-- only by this column — a deposit or withdrawal is either 'bank' or 'cash',
-- never both. Existing rows default to 'bank': every transaction recorded
-- before this column existed was a bank one, since cash wasn't tracked yet.
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'bank';
