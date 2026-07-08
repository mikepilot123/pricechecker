-- Tracks which backend each ticket_media object actually lives in, now that
-- new uploads go to Cloudflare R2 instead of Vercel Blob. Existing rows
-- default to 'vercel_blob' (where they already live) so deleteMedia() in
-- lib/media.js knows which API to call to remove the underlying file.
-- storage_key holds the R2 object key (needed to delete R2 objects; Vercel
-- Blob deletes by URL alone, so legacy rows leave this null).
ALTER TABLE ticket_media ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'vercel_blob';
ALTER TABLE ticket_media ADD COLUMN IF NOT EXISTS storage_key TEXT;
