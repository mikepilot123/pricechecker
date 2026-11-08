-- What the client left with the device at check-in (charger, case, bag…),
-- so it goes back to them at pickup. Asked on Check In's device step and
-- editable from the repair modal; see lib/tickets.js's accessoriesFrom().
--
-- Stored as the text shown to staff: "Charger, Case, Other: blue pouch", or
-- "None" when the client left nothing. '' means it wasn't recorded (tickets
-- logged before this existed, or quick logs from the Prices tab).
--
-- Mirrored idempotently in lib/db.js's ensureSchema().
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS accessories TEXT NOT NULL DEFAULT '';
