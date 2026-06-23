import { sql } from "./db.js";

// Keep in sync with assets/intake.js STATUSES.
const STATUSES = [
  "Received",
  "Diagnosing",
  "Waiting for Parts",
  "In Progress",
  "Repaired",
  "Picked Up",
  "Cancelled",
];

// Accept both the current frontend field names and the older ones the first
// intake dashboard used, same compatibility shim apps-script/Code.gs had.
function hasCustomerName(p) {
  return p.customerName != null || p.client != null;
}
function customerNameFrom(p) {
  return p.customerName != null ? p.customerName : (p.client || "");
}
function hasIssues(p) {
  return p.issues != null || p.issue != null;
}
function issuesFrom(p) {
  return p.issues != null ? p.issues : (p.issue || "");
}

function snapshotFromRow(row) {
  return {
    customerName: row.customer_name || "",
    phone: row.phone || "",
    device: row.device || "",
    issues: row.issues || "",
    status: row.status || "",
    notes: row.notes || "",
  };
}

async function insertVersion(ticketId, versionNumber, summary, changeType, snapshot) {
  await sql`
    INSERT INTO ticket_versions (ticket_id, version_number, snapshot, change_summary, change_type)
    VALUES (${ticketId}, ${versionNumber}, ${JSON.stringify(snapshot)}::jsonb, ${summary}, ${changeType})
  `;
}

// Rebuilds the same flat shape apps-script/Code.gs's rowToTicket() returned,
// including a synthesized `history` text blob (one "[iso] summary" line per
// version row) so the existing frontend's historyHtml() renderer — which
// parses that exact format — needs zero changes.
async function rowToTicket(row) {
  const versions = await sql`
    SELECT version_number, change_summary, created_at
    FROM ticket_versions
    WHERE ticket_id = ${row.id}
    ORDER BY version_number ASC
  `;
  const history = versions
    .map((v) => `[${new Date(v.created_at).toISOString()}] ${v.change_summary}`)
    .join("\n");

  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    customerName: row.customer_name || "",
    client: row.customer_name || "",
    phone: row.phone || "",
    device: row.device || "",
    issues: row.issues || "",
    issue: row.issues || "",
    status: row.status || "",
    notes: row.notes || "",
    history,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function getTicket(id) {
  const rows = await sql`SELECT * FROM tickets WHERE id = ${id}`;
  if (!rows.length) throw new Error("Ticket not found: " + id);
  return rowToTicket(rows[0]);
}

export async function listTickets({ includeDeleted = false } = {}) {
  const rows = includeDeleted
    ? await sql`SELECT * FROM tickets ORDER BY updated_at DESC`
    : await sql`SELECT * FROM tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
  return Promise.all(rows.map(rowToTicket));
}

export async function addTicket(p) {
  const id = "T" + Date.now().toString(36).toUpperCase();
  const status = STATUSES.includes(p.status) ? p.status : "Received";
  const snapshot = {
    customerName: customerNameFrom(p),
    phone: p.phone || "",
    device: p.device || "",
    issues: issuesFrom(p),
    status,
    notes: p.notes || "",
  };

  await sql`
    INSERT INTO tickets (id, customer_name, phone, device, issues, status, notes)
    VALUES (${id}, ${snapshot.customerName}, ${snapshot.phone}, ${snapshot.device}, ${snapshot.issues}, ${snapshot.status}, ${snapshot.notes})
  `;
  await insertVersion(id, 1, `Logged — ${status}`, "create", snapshot);
  return getTicket(id);
}

export async function updateTicket(p) {
  if (!p.id) throw new Error("Ticket ID is required");
  const rows = await sql`SELECT * FROM tickets WHERE id = ${p.id}`;
  if (!rows.length) throw new Error("Ticket not found: " + p.id);
  const current = rows[0];

  const customerName = hasCustomerName(p) ? customerNameFrom(p) : current.customer_name;
  const phone = p.phone != null ? p.phone : current.phone;
  const device = p.device != null ? p.device : current.device;
  const issues = hasIssues(p) ? issuesFrom(p) : current.issues;
  const status = STATUSES.includes(p.status) ? p.status : current.status;
  const notes = p.notes != null ? p.notes : current.notes;

  const lines = [];
  if (status !== current.status) lines.push(`Status: ${current.status} → ${status}`);
  if (device !== current.device) lines.push(`Device updated to ${device}`);
  if (issues !== current.issues) lines.push(`Issues updated: ${issues || "—"}`);
  if (notes !== current.notes) lines.push("Notes updated");
  if (customerName !== current.customer_name) lines.push(`Customer updated to ${customerName}`);
  if (phone !== current.phone) lines.push(`Phone updated to ${phone}`);

  const changed = lines.length > 0;
  const nextVersion = changed ? current.current_version + 1 : current.current_version;

  await sql`
    UPDATE tickets
    SET customer_name = ${customerName}, phone = ${phone}, device = ${device},
        issues = ${issues}, status = ${status}, notes = ${notes},
        updated_at = now(), current_version = ${nextVersion}
    WHERE id = ${p.id}
  `;
  if (changed) {
    await insertVersion(p.id, nextVersion, lines.join("; "), "update", {
      customerName, phone, device, issues, status, notes,
    });
  }
  return getTicket(p.id);
}

export async function deleteTicket(p) {
  if (!p.id) throw new Error("Ticket ID is required");
  const rows = await sql`SELECT * FROM tickets WHERE id = ${p.id}`;
  if (!rows.length) throw new Error("Ticket not found: " + p.id);
  const current = rows[0];
  if (current.deleted_at) throw new Error("Ticket already deleted: " + p.id);

  const nextVersion = current.current_version + 1;
  await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${p.id}`;
  await insertVersion(p.id, nextVersion, "Deleted", "delete", snapshotFromRow(current));
  return p.id;
}

// Soft-deletes every active ticket (was a hard wipe in apps-script/Code.gs) —
// each one gets its own version row, so "Clear all" is fully reversible via
// restoreBackup, one ticket at a time, from the Settings version-history UI.
export async function clearAll() {
  const actives = await sql`SELECT * FROM tickets WHERE deleted_at IS NULL`;
  for (const row of actives) {
    const nextVersion = row.current_version + 1;
    await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${row.id}`;
    await insertVersion(row.id, nextVersion, "Cleared (bulk delete)", "delete", snapshotFromRow(row));
  }
  return actives.length;
}

export async function listBackups(p) {
  if (!p.id) throw new Error("Ticket ID is required");
  const rows = await sql`
    SELECT version_number, change_summary, change_type, snapshot, created_at
    FROM ticket_versions
    WHERE ticket_id = ${p.id}
    ORDER BY version_number DESC
  `;
  return rows.map((v) => ({
    versionNumber: v.version_number,
    changeSummary: v.change_summary,
    changeType: v.change_type,
    snapshot: v.snapshot,
    createdAt: new Date(v.created_at).toISOString(),
  }));
}

// Restores a ticket to any prior snapshot — including one captured right
// before a delete, which is what makes a deleted ticket recoverable. Restoring
// never rewrites old version rows; it always appends a new one, so the
// timeline stays a true append-only log.
export async function restoreBackup(p) {
  if (!p.id || p.versionNumber == null) throw new Error("Ticket ID and versionNumber are required");
  const tRows = await sql`SELECT * FROM tickets WHERE id = ${p.id}`;
  if (!tRows.length) throw new Error("Ticket not found: " + p.id);
  const current = tRows[0];

  const vRows = await sql`
    SELECT * FROM ticket_versions WHERE ticket_id = ${p.id} AND version_number = ${p.versionNumber}
  `;
  if (!vRows.length) throw new Error("Version not found: " + p.versionNumber);
  const snap = vRows[0].snapshot;
  const wasDeleted = !!current.deleted_at;
  const nextVersion = current.current_version + 1;

  await sql`
    UPDATE tickets
    SET customer_name = ${snap.customerName || ""}, phone = ${snap.phone || ""},
        device = ${snap.device || ""}, issues = ${snap.issues || ""},
        status = ${snap.status || "Received"}, notes = ${snap.notes || ""},
        deleted_at = NULL, updated_at = now(), current_version = ${nextVersion}
    WHERE id = ${p.id}
  `;
  const summary = wasDeleted
    ? "Restored from backup (was deleted)"
    : `Restored to version ${p.versionNumber}`;
  await insertVersion(p.id, nextVersion, summary, "restore", snap);
  return getTicket(p.id);
}
