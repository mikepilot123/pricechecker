import { sql } from "./db.js";
import { del as deleteVercelBlob } from "@vercel/blob";
import { deleteObject as deleteR2Object } from "./r2.js";

const TYPES = new Set(["photo", "video"]);

function rowToMedia(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    url: row.url,
    type: row.type,
    storage: row.storage || "vercel_blob",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listMedia(ticketId) {
  const id = String(ticketId || "").trim();
  if (!id) throw new Error("Ticket ID is required");
  const rows = await sql`
    SELECT id, ticket_id, url, type, storage, created_at
    FROM ticket_media
    WHERE ticket_id = ${id}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToMedia);
}

export async function addMedia(p) {
  const ticketId = String(p.ticketId || "").trim();
  const url = String(p.url || "").trim();
  const type = TYPES.has(p.type) ? p.type : "photo";
  const key = p.key ? String(p.key).trim() : null;
  // New uploads always go through api/media-upload.js's R2 presigned-URL
  // flow and always pass a `key`. Rows without one are pre-migration and
  // still live in Vercel Blob — see migrations/013.
  const storage = key ? "r2" : "vercel_blob";
  if (!ticketId) throw new Error("Ticket ID is required");
  if (!url) throw new Error("Media URL is required");
  const rows = await sql`
    INSERT INTO ticket_media (ticket_id, url, type, storage, storage_key)
    VALUES (${ticketId}, ${url}, ${type}, ${storage}, ${key})
    RETURNING id, ticket_id, url, type, storage, created_at
  `;
  return rowToMedia(rows[0]);
}

export async function deleteMedia(p) {
  if (!p.id) throw new Error("Media ID is required");
  const rows = await sql`SELECT * FROM ticket_media WHERE id = ${p.id}`;
  if (!rows.length) throw new Error("Media not found: " + p.id);
  const row = rows[0];
  // Delete the DB row first, then best-effort clean up storage — a
  // dangling object costs a few KB/MB of storage but never breaks the app,
  // whereas leaving the DB row behind after a failed storage delete would
  // show staff a broken gallery tile. This ordering keeps the two in sync
  // in the direction that matters: the app never points at a deleted row.
  await sql`DELETE FROM ticket_media WHERE id = ${p.id}`;
  if (row.storage === "r2" && row.storage_key) {
    await deleteR2Object(row.storage_key).catch(() => {});
  } else {
    await deleteVercelBlob(row.url).catch(() => {});
  }
  return p.id;
}
