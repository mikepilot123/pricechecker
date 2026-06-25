-- Technician assignment for intake tickets. Kept optional/blank so assignment
-- can happen only after a device is logged.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS technician TEXT NOT NULL DEFAULT '';
