-- "Drop by Ainsley" was split into two statuses: "To Be Dropped by Ainsley"
-- (waiting to go out) and "Being Repaired by Ainsley" (with Ainsley now).
-- Repairs still on the old status move to "Being Repaired by Ainsley". Also
-- run, idempotently, by lib/db.js's ensureSchema().
UPDATE tickets SET status = 'Being Repaired by Ainsley', updated_at = now()
WHERE status = 'Drop by Ainsley';
