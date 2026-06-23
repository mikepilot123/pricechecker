-- Repair Hub intake schema (Postgres / Neon).
--
-- Replaces the Google Sheet as the source of truth for device tickets.
-- `ticket_versions` is an append-only log: every create/update/delete/restore
-- writes a new row here rather than mutating history in place, so any past
-- state of a ticket (including a deleted one) can be restored later via the
-- listBackups / restoreBackup actions in /api/intake.js.

CREATE TABLE IF NOT EXISTS tickets (
  id              TEXT PRIMARY KEY,         -- e.g. "T1A2B3C4" — same base36 id scheme as the old Apps Script backend
  customer_name   TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  device          TEXT NOT NULL DEFAULT '',
  issues          TEXT NOT NULL DEFAULT '',  -- comma-joined string, same format the frontend already parses
  status          TEXT NOT NULL DEFAULT 'Received',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,               -- soft delete; NULL = active. Cleared (NULL'd) on restore.
  current_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tickets_deleted_at ON tickets (deleted_at);
CREATE INDEX IF NOT EXISTS idx_tickets_updated_at ON tickets (updated_at DESC);

CREATE TABLE IF NOT EXISTS ticket_versions (
  id              BIGSERIAL PRIMARY KEY,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,         -- 1, 2, 3... per ticket; matches tickets.current_version at write time
  snapshot        JSONB NOT NULL,           -- {customerName, phone, device, issues, status, notes, ...}
  change_summary  TEXT NOT NULL,            -- human-readable diff, e.g. "Status: Received -> Diagnosing"
  change_type     TEXT NOT NULL,            -- create | update | delete | restore | import
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_versions_ticket_id ON ticket_versions (ticket_id, version_number DESC);

-- Whole-list snapshots, matching the existing frontend's Settings -> Restore
-- UI (assets/intake.js openRestoreBackupModal/confirmRestoreBackup), which
-- expects a flat list of {id, created, count} and a single restoreBackup(id)
-- action that swaps in an entire prior ticket set at once. One is created
-- automatically on every "clear", and again as a safety net before every
-- restore, so neither action ever loses data permanently.
CREATE TABLE IF NOT EXISTS intake_backups (
  id          TEXT PRIMARY KEY,        -- "B" + millis, same id scheme as the old Apps Script backup sheets
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot    JSONB NOT NULL,          -- array of ticket rows (full tickets.* shape) at backup time
  count       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intake_backups_created_at ON intake_backups (created_at DESC);
