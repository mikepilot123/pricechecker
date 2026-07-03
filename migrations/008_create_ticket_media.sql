-- Photos/videos of the physical device attached to a check-in ticket. Files
-- live in Vercel Blob; this table only records the public URL per ticket.
CREATE TABLE IF NOT EXISTS ticket_media (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'photo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_media_ticket ON ticket_media (ticket_id, created_at DESC);
