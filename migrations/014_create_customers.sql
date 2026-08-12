-- Shared customer directory, matched by phone number (same digits-only key
-- assets/intake.js's checkinGroupKey() uses to group one check-in's devices
-- into a single card). Populated automatically whenever a device is logged
-- or edited (see lib/customers.js's upsertCustomerFromTicket, called from
-- lib/tickets.js's addTicket/updateTicket) — there's no separate "add
-- customer" flow. Device counts and last-visit dates are computed at read
-- time from tickets rather than stored here, so they never drift.
CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  phone_key   TEXT NOT NULL UNIQUE,   -- digits-only phone; the match key
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (lower(name));
