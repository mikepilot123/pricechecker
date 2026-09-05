-- Legacy rows keep NULL: reclaimed_at still identifies fully collected cash.
-- First edit materializes the old collection as a receipt without losing history.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaimed_amount NUMERIC(12, 2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reclaim_collections JSONB NOT NULL DEFAULT '[]'::jsonb;
