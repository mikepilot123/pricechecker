-- A lasting record of saves that failed (Vercel's Hobby plan keeps logs for
-- an hour). Written by lib/save-failures.js; listed in Settings → Failed
-- saves. The request body is stored with the PIN and secrets removed.
-- Also created, idempotently, by lib/db.js's ensureSchema().
CREATE TABLE IF NOT EXISTS save_failures (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  route      TEXT NOT NULL DEFAULT '',
  method     TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'server',
  error      TEXT NOT NULL DEFAULT '',
  body       JSONB NOT NULL DEFAULT '{}'::jsonb,
  device_id  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_save_failures_created ON save_failures (created_at DESC);
