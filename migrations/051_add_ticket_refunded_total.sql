-- Money handed back to a client on a repair (e.g. they paid up front for one
-- issue, the diagnosis found another, and they chose not to go ahead). The
-- amount paid goes down by each refund; this keeps the running total so the
-- repair still shows what was returned. Each refund's details are in the
-- repair's activity log. See refundTicket() in lib/tickets.js.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(12, 2) NOT NULL DEFAULT 0;
