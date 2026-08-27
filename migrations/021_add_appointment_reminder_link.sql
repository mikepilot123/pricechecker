-- Reminder link for appointments, mirroring the expense_id column added in
-- 020 for cash-reclaim reminders. See lib/appointments.js's
-- syncAppointmentReminder() — every appointment automatically gets (or
-- updates/retires) a "heads up, this is coming up" reminder.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS appointment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_reminders_appointment ON reminders (appointment_id) WHERE appointment_id IS NOT NULL;
