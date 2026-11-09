-- Collection appointments the client booked themselves (from the ready email,
-- lib/collection-booking.js) are flagged so staff notice them: a number on the
-- Appointments nav item until someone opens the tab.
--
-- client_booked_at — when the client booked (or last moved) it.
-- seen_at          — when staff opened Appointments after that; NULL = new.
--
-- Mirrored idempotently in lib/db.js's ensureSchema().
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_booked_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
