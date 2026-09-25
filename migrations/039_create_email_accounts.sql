-- Invoice email: mailboxes staff link in Settings → Email (passwords are
-- AES-256-GCM encrypted by lib/email.js) and a log of emails sent per invoice.
CREATE TABLE IF NOT EXISTS email_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'smtp',
  label TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 465,
  secure BOOLEAN NOT NULL DEFAULT TRUE,
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  last_tested_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE custom_invoices ADD COLUMN IF NOT EXISTS email_log JSONB NOT NULL DEFAULT '[]'::jsonb;
