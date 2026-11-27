-- Each "log this repair" attempt from the app carries an id the device keeps
-- across retries. If the save reached the server but the answer was lost
-- (timeout, dropped connection) and staff tap Save again, the retry finds
-- the repair already logged instead of creating a second one. NULL for
-- repairs logged before this, or from places that don't send one.
-- Also run, idempotently, by lib/db.js's ensureSchema().
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_client_request_id
  ON tickets (client_request_id) WHERE client_request_id IS NOT NULL;
