import { sql } from "./db.js";

/* ---- Device diagnostics saved against a repair -------------------------- */
// The Diagnostics tab (assets/diagnostics.js) records a before-repair and an
// after-repair test pass for one ticket; both are stored here, one row per
// ticket, so the results are read back from the repair itself rather than
// living only on whichever browser ran the test.
//
// Results are { partKey: "pass" | "fail" | "na" }. Part keys are defined by
// the device layouts in assets/diagnostics.js — the server doesn't need to
// know them, only that they're short identifiers, so a new test added to a
// layout needs no change here.

const DEVICE_TYPES = new Set(["phone", "laptop"]);
const RESULT_VALUES = new Set(["pass", "fail", "na"]);
const PART_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MAX_PARTS = 80;
const MAX_NOTES = 4000;

function cleanResults(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, result] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_PARTS) break;
    if (PART_KEY.test(key) && RESULT_VALUES.has(result)) out[key] = result;
  }
  return out;
}

// JSONB comes back parsed from Neon, but be lenient in case a driver hands
// back the raw text.
function readResults(value) {
  if (typeof value === "string") {
    try { return cleanResults(JSON.parse(value)); } catch { return {}; }
  }
  return cleanResults(value);
}

function rowToDiagnostic(row) {
  return {
    ticketId: row.ticket_id,
    deviceType: DEVICE_TYPES.has(row.device_type) ? row.device_type : "phone",
    before: readResults(row.before_results),
    after: readResults(row.after_results),
    notes: row.notes || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function ticketIdFrom(p) {
  const id = String(p == null ? "" : p).trim();
  if (!id) throw new Error("Ticket ID is required");
  return id;
}

export async function getTicketDiagnostic(ticketId) {
  const id = ticketIdFrom(ticketId);
  const rows = await sql`SELECT * FROM ticket_diagnostics WHERE ticket_id = ${id}`;
  return rows.length ? rowToDiagnostic(rows[0]) : null;
}

// Every saved diagnostic on a repair that still exists, newest first. Small
// rows, so the tab pulls them all at once to badge the repair picker.
export async function listTicketDiagnostics() {
  const rows = await sql`
    SELECT d.* FROM ticket_diagnostics d
    JOIN tickets t ON t.id = d.ticket_id
    WHERE t.deleted_at IS NULL
    ORDER BY d.updated_at DESC
  `;
  return rows.map(rowToDiagnostic);
}

// Upsert. The tab saves the whole record on every change, so this replaces
// rather than merges — a result cleared in the tab must clear here too.
export async function saveTicketDiagnostic(p) {
  const id = ticketIdFrom(p.ticketId);
  const deviceType = DEVICE_TYPES.has(p.deviceType) ? p.deviceType : "phone";
  const before = cleanResults(p.before);
  const after = cleanResults(p.after);
  const notes = String(p.notes == null ? "" : p.notes).slice(0, MAX_NOTES);

  const tickets = await sql`SELECT id FROM tickets WHERE id = ${id} AND deleted_at IS NULL`;
  if (!tickets.length) throw new Error("Ticket not found: " + id);

  // Clearing every result and the notes leaves nothing worth keeping; drop
  // the row so the repair reads as "not tested" again.
  if (!Object.keys(before).length && !Object.keys(after).length && !notes.trim()) {
    await sql`DELETE FROM ticket_diagnostics WHERE ticket_id = ${id}`;
    return null;
  }

  const rows = await sql`
    INSERT INTO ticket_diagnostics (ticket_id, device_type, before_results, after_results, notes)
    VALUES (${id}, ${deviceType}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${notes})
    ON CONFLICT (ticket_id) DO UPDATE SET
      device_type = EXCLUDED.device_type,
      before_results = EXCLUDED.before_results,
      after_results = EXCLUDED.after_results,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING *
  `;
  return rowToDiagnostic(rows[0]);
}

export async function deleteTicketDiagnostic(p) {
  const id = ticketIdFrom(p.ticketId);
  await sql`DELETE FROM ticket_diagnostics WHERE ticket_id = ${id}`;
  return id;
}
