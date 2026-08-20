-- Repair due dates and the one-day active-repair check reminder.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS repair_due_date DATE;

CREATE INDEX IF NOT EXISTS idx_tickets_repair_due_date
  ON tickets (deleted_at, status, repair_due_date);
