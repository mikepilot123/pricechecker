-- Shared, editable app settings. Everything configurable up to now has been
-- either client-side (the PIN, in localStorage) or an env var needing a
-- redeploy — neither works for the card-machine fee rates, which staff need
-- to change themselves and which every device must agree on.
--
-- Deliberately a generic key/value store rather than an account-specific
-- table, so the next thing that needs a shared setting doesn't need a
-- migration of its own.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
