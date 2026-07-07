ALTER TABLE leads ADD COLUMN IF NOT EXISTS legacy_notes_migrated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS lead_notes (
  id BIGSERIAL PRIMARY KEY,
  lead_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id, created_at DESC);

WITH claimed AS (
  UPDATE leads
  SET legacy_notes_migrated_at = now()
  WHERE notes <> '' AND legacy_notes_migrated_at IS NULL
  RETURNING id, notes, updated_at
)
INSERT INTO lead_notes (lead_id, note, created_at)
SELECT id, notes, updated_at
FROM claimed;

DELETE FROM lead_notes a
USING lead_notes b
WHERE a.lead_id = b.lead_id
  AND a.note = b.note
  AND a.created_at = b.created_at
  AND a.id > b.id;

DELETE FROM lead_notes old
USING lead_notes keep
WHERE old.lead_id = keep.lead_id
  AND btrim(old.note) = btrim(keep.note)
  AND (old.created_at < keep.created_at OR (old.created_at = keep.created_at AND old.id < keep.id));
