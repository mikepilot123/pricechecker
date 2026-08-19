-- Reminders: assignee, priority label, and optional link to a repair ticket.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT '';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT '';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS ticket_id TEXT;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS ticket_label TEXT NOT NULL DEFAULT '';
