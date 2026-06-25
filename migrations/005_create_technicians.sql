-- Shared technician roster for post-log assignment.
CREATE TABLE IF NOT EXISTS technicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_technicians_name ON technicians (lower(name));

INSERT INTO technicians (id, name)
VALUES
  ('TECH_LIANA', 'Liana'),
  ('TECH_MICHAEL', 'Michael'),
  ('TECH_MARCUS', 'Marcus')
ON CONFLICT (name) DO NOTHING;
