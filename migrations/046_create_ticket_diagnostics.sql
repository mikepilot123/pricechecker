-- Device diagnostics saved against a repair (lib/diagnostics.js).
--
-- One row per ticket: the before-repair and after-repair test passes live
-- side by side so the "what got fixed / what broke" comparison can always be
-- drawn from the repair itself. Results are { partKey: "pass"|"fail"|"na" }
-- maps; untested parts are simply absent. Internal only — never shown on the
-- customer's invoice.
CREATE TABLE IF NOT EXISTS ticket_diagnostics (
  ticket_id       TEXT PRIMARY KEY,
  device_type     TEXT NOT NULL DEFAULT 'phone',
  before_results  JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_results   JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_diagnostics_updated ON ticket_diagnostics (updated_at DESC);
