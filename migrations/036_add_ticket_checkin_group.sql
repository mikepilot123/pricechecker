-- A device added to a client's existing check-in later on (the "+" on a
-- repair card) is still its own ticket, but it points at the ticket it was
-- added to so the Repairs list keeps showing them on one card.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS checkin_group TEXT NOT NULL DEFAULT '';
