-- Running note log for repair tickets, mirroring lead_notes (migration 012).
--
-- tickets.notes stays exactly as it is: it's a single field that staff fill in
-- at check-in and it gets rendered on the customer-facing invoice
-- (lib/invoices.js), so it must NOT become a scratchpad. These are internal
-- working notes — one row per note, appended from the ticket timeline modal
-- and never shown to a customer.
CREATE TABLE IF NOT EXISTS ticket_notes (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes (ticket_id, created_at DESC);
