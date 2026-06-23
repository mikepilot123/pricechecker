-- Customer email for sending invoices. Optional on older rows until staff add it.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
