-- What a device is for. "" is an ordinary browser; "backup" is the nightly
-- backup (apps-script/NightlyBackup.gs), which registers itself read-only with
-- nothing hidden, so it never waits on the owner to allow Accounting.
--
-- Mirrored idempotently in lib/db.js's ensureSchema().
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '';
