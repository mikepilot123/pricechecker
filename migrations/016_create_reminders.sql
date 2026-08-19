-- Staff reminders/to-do list (Reminders tab). Soft-deleted like expenses and
-- appointments so a stray delete is recoverable in the DB if ever needed.
CREATE TABLE IF NOT EXISTS reminders (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  due_at      TIMESTAMPTZ,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reminders_open ON reminders (deleted_at, done, due_at);
