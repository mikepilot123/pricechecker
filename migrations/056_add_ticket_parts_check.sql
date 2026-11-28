-- Parts check (master device only — see lib/parts-check.js): what a finished
-- repair used. '' = not checked yet, 'stock' = a part from our stock,
-- 'expense' = a part bought for it (parts_check_expense_id links the expense),
-- 'none' = no part needed. Also run, idempotently, by lib/db.js's
-- ensureSchema().
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS parts_check TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS parts_check_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS parts_check_expense_id TEXT NOT NULL DEFAULT '';
