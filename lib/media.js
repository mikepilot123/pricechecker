import { sql } from "./db.js";
import { del } from "@vercel/blob";

const TYPES = new Set(["photo", "video"]);

function rowToMedia(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    url: row.url,
    type: row.type,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listMedia(ticketId) {
  const id = String(ticketId || "").trim();
  if (!id) throw new Error("Ticket ID is required");
  const rows = await sql`
    SELECT id, ticket_id, url, type, created_at
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
  if (!ticketId) throw new Error("Ticket ID is required");
  if (!url) throw new Error("Media URL is required");
  const rows = await sql`
    INSERT INTO ticket_media (ticket_id, url, type)
    VALUES (${ticketId}, ${url}, ${type})
    RETURNING id, ticket_id, url, type, created_at
  `;
  return rowToMedia(rows[0]);
}

export async function deleteMedia(p) {
  if (!p.id) throw new Error("Media ID is required");
  const rows = await sql`SELECT * FROM ticket_media WHERE id = ${p.id}`;
  if (!rows.length) throw new Error("Media not found: " + p.id);
  await sql`DELETE FROM ticket_media WHERE id = ${p.id}`;
  // Best-effort — a dangling Blob object costs storage but never breaks the
  // app, so don't let a delete API hiccup block removing the DB row.
  await del(rows[0].url).catch(() => {});
  return p.id;
}
