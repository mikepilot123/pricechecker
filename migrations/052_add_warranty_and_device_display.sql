-- Devices Under Warranty (Repairs → Devices Under Warranty).
--
-- picked_up_at: when a repair was handed back fixed ("Picked Up"); the
-- 60-day warranty on the shop's invoices runs from here. Set by
-- updateTicket()/addTicket() in lib/tickets.js; existing picked-up repairs
-- are backfilled from the activity log below (and again, idempotently, by
-- lib/db.js's ensureSchema()).
--
-- warranty_of: on a repair opened by "Claim warranty", the repair it's a
-- warranty claim on. See claimWarranty() in lib/tickets.js.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS warranty_of TEXT NOT NULL DEFAULT '';

UPDATE tickets t
SET picked_up_at = COALESCE(
  (SELECT max(v.created_at) FROM ticket_versions v
   WHERE v.ticket_id = t.id AND v.change_summary LIKE '%→ Picked Up%'),
  t.created_at)
WHERE t.status = 'Picked Up' AND t.picked_up_at IS NULL;

-- Settings → Devices: hide the "waiting on parts" notice at the bottom of
-- repair cards on a device. A display choice, not a permission, so it's
-- separate from hidden_sections and off (notice shown) by default.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hide_parts_alert BOOLEAN NOT NULL DEFAULT FALSE;
