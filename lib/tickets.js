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

function moneyFrom(value, label) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must be a valid non-negative amount`);
  return (Math.round(Number(text) * 100) / 100).toFixed(2);
}

function repairCostFrom(p) {
  return moneyFrom(p.repairCost != null ? p.repairCost : p.cost, "Repair cost");
}

function amountPaidFrom(p) {
  return moneyFrom(p.amountPaid != null ? p.amountPaid : p.paid, "Amount paid");
}

const DEFAULT_TECHNICIANS = ["Liana", "Michael", "Marcus"];

function snapshotFromRow(row) {
  return {
    customerName: row.customer_name || "",
    phone: row.phone || "",
    email: row.email || "",
    device: row.device || "",
    issues: row.issues || "",
    status: row.status || "",
    notes: row.notes || "",
    repairCost: row.repair_cost == null ? "" : String(row.repair_cost),
    amountPaid: row.amount_paid == null ? "" : String(row.amount_paid),
    technician: row.technician || "",
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
    email: row.email || "",
    device: row.device || "",
    issues: row.issues || "",
    issue: row.issues || "",
    status: row.status || "",
    notes: row.notes || "",
    repairCost: row.repair_cost == null ? "" : String(row.repair_cost),
    amountPaid: row.amount_paid == null ? "" : String(row.amount_paid),
    technician: row.technician || "",
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
    email: p.email || "",
    device: p.device || "",
    issues: issuesFrom(p),
    status,
    notes: p.notes || "",
    repairCost: repairCostFrom(p),
    amountPaid: amountPaidFrom(p),
    technician: "",
  };

  await sql`
    INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician)
    VALUES (${id}, ${snapshot.customerName}, ${snapshot.phone}, ${snapshot.email}, ${snapshot.device}, ${snapshot.issues}, ${snapshot.status}, ${snapshot.notes}, ${snapshot.repairCost}, ${snapshot.amountPaid}, ${snapshot.technician})
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
  const email = p.email != null ? p.email : current.email;
  const device = p.device != null ? p.device : current.device;
  const issues = hasIssues(p) ? issuesFrom(p) : current.issues;
  const status = STATUSES.includes(p.status) ? p.status : current.status;
  const notes = p.notes != null ? p.notes : current.notes;
  const repairCost = p.repairCost != null || p.cost != null ? repairCostFrom(p) : moneyFrom(current.repair_cost, "Repair cost");
  const amountPaid = p.amountPaid != null || p.paid != null ? amountPaidFrom(p) : moneyFrom(current.amount_paid, "Amount paid");
  const technician = p.technician != null ? String(p.technician).trim() : (current.technician || "");

  const lines = [];
  if (status !== current.status) lines.push(`Status: ${current.status} → ${status}`);
  if (device !== current.device) lines.push(`Device updated to ${device}`);
  if (issues !== current.issues) lines.push(`Issues updated: ${issues || "—"}`);
  if (notes !== current.notes) lines.push("Notes updated");
  if (customerName !== current.customer_name) lines.push(`Customer updated to ${customerName}`);
  if (phone !== current.phone) lines.push(`Phone updated to ${phone}`);
  if (email !== current.email) lines.push(`Email updated to ${email || "—"}`);
  if (repairCost !== moneyFrom(current.repair_cost, "Repair cost")) lines.push(`Repair cost updated to ${repairCost == null ? "—" : "TT$" + repairCost}`);
  if (amountPaid !== moneyFrom(current.amount_paid, "Amount paid")) lines.push(`Amount paid updated to ${amountPaid == null ? "—" : "TT$" + amountPaid}`);
  if (technician !== (current.technician || "")) lines.push(`Technician assigned to ${technician || "Unassigned"}`);

  const changed = lines.length > 0;
  const nextVersion = changed ? current.current_version + 1 : current.current_version;

  await sql`
    UPDATE tickets
    SET customer_name = ${customerName}, phone = ${phone}, email = ${email}, device = ${device},
        issues = ${issues}, status = ${status}, notes = ${notes},
        repair_cost = ${repairCost}, amount_paid = ${amountPaid}, technician = ${technician},
        updated_at = now(), current_version = ${nextVersion}
    WHERE id = ${p.id}
  `;
  if (changed) {
    await insertVersion(p.id, nextVersion, lines.join("; "), "update", {
      customerName, phone, email, device, issues, status, notes, repairCost, amountPaid, technician,
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

// ---- Whole-list backups ----------------------------------------------------
// Matches the already-shipped frontend contract exactly (assets/intake.js
// openRestoreBackupModal/confirmRestoreBackup, ported from the old Apps
// Script createBackup/listBackups/restoreBackup): a "backup" is a snapshot of
// every active ticket at one moment, identified by id, restorable as a whole.
// This sits alongside (not instead of) the per-ticket ticket_versions log
// above — that log still powers each ticket's own structured history text.

async function snapshotActiveTickets() {
  const rows = await sql`SELECT * FROM tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
  return Promise.all(rows.map(rowToTicket));
}

async function createBackup() {
  const snapshot = await snapshotActiveTickets();
  const id = "B" + Date.now();
  const createdAt = new Date();
  await sql`
    INSERT INTO intake_backups (id, created_at, snapshot, count)
    VALUES (${id}, ${createdAt.toISOString()}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.length})
  `;
  return { id, created: createdAt.toISOString(), count: snapshot.length };
}

// Soft-deletes every active ticket (was a hard wipe in apps-script/Code.gs),
// after snapshotting them into a backup — same "back up, then clear" order
// the old Apps Script clearTickets() used, so Settings -> Restore can bring
// everything back in one shot.
export async function clearAll() {
  const backup = await createBackup();
  const actives = await sql`SELECT * FROM tickets WHERE deleted_at IS NULL`;
  for (const row of actives) {
    const nextVersion = row.current_version + 1;
    await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${row.id}`;
    await insertVersion(row.id, nextVersion, "Cleared (bulk delete)", "delete", snapshotFromRow(row));
  }
  return { deletedCount: actives.length, backup };
}

export async function listBackups() {
  const rows = await sql`SELECT id, created_at, count FROM intake_backups ORDER BY created_at DESC`;
  return rows.map((b) => ({
    id: b.id,
    created: new Date(b.created_at).toISOString(),
    count: b.count,
  }));
}

export async function listTechnicians() {
  const rows = await sql`SELECT id, name, created_at FROM technicians ORDER BY lower(name) ASC`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

export async function addTechnician(p) {
  const name = String(p.name || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Technician name is required");
  if (name.length > 80) throw new Error("Technician name is too long");
  const id = "TECH" + Date.now().toString(36).toUpperCase();
  await sql`
    INSERT INTO technicians (id, name)
    VALUES (${id}, ${name})
    ON CONFLICT (name) DO NOTHING
  `;
  return listTechnicians();
}

export async function deleteTechnician(p) {
  const name = String(p.name || "").trim();
  if (!name) throw new Error("Technician name is required");
  if (DEFAULT_TECHNICIANS.some((defaultName) => defaultName.toLowerCase() === name.toLowerCase())) {
    throw new Error("Default technicians can't be deleted");
  }
  await sql`DELETE FROM technicians WHERE name = ${name}`;
  return listTechnicians();
}

// Replaces the entire active ticket set with a prior backup's snapshot —
// mirrors the old Apps Script restoreBackup()'s full-sheet swap. Takes a
// safety backup of the current state first, so restoring is itself always
// reversible. Every affected ticket still gets its own ticket_versions row,
// so its individual history stays intact through the restore.
export async function restoreBackup(p) {
  if (!p.id) throw new Error("Backup ID is required");
  const rows = await sql`SELECT * FROM intake_backups WHERE id = ${p.id}`;
  if (!rows.length) throw new Error("Backup not found: " + p.id);
  const target = rows[0].snapshot; // array of ticket-shaped objects

  const safetyBackup = await createBackup();

  const actives = await sql`SELECT * FROM tickets WHERE deleted_at IS NULL`;
  const targetIds = new Set(target.map((t) => t.id));
  for (const row of actives) {
    if (targetIds.has(row.id)) continue; // will be overwritten below anyway
    const nextVersion = row.current_version + 1;
    await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${row.id}`;
    await insertVersion(row.id, nextVersion, "Removed by backup restore", "delete", snapshotFromRow(row));
  }

  for (const t of target) {
    const existing = await sql`SELECT * FROM tickets WHERE id = ${t.id}`;
    const snap = {
      customerName: t.customerName || "",
      phone: t.phone || "",
      email: t.email || "",
      device: t.device || "",
      issues: t.issues || "",
      status: t.status || "Received",
      notes: t.notes || "",
      repairCost: moneyFrom(t.repairCost != null ? t.repairCost : t.cost, "Repair cost"),
      amountPaid: moneyFrom(t.amountPaid != null ? t.amountPaid : t.paid, "Amount paid"),
      technician: t.technician || "",
    };
    if (existing.length) {
      const nextVersion = existing[0].current_version + 1;
      await sql`
        UPDATE tickets
        SET customer_name = ${snap.customerName}, phone = ${snap.phone}, email = ${snap.email}, device = ${snap.device},
            issues = ${snap.issues}, status = ${snap.status}, notes = ${snap.notes},
            repair_cost = ${snap.repairCost}, amount_paid = ${snap.amountPaid}, technician = ${snap.technician},
            deleted_at = NULL, updated_at = now(), current_version = ${nextVersion}
        WHERE id = ${t.id}
      `;
      await insertVersion(t.id, nextVersion, "Restored from backup " + p.id, "restore", snap);
    } else {
      await sql`
        INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician, created_at)
        VALUES (${t.id}, ${snap.customerName}, ${snap.phone}, ${snap.email}, ${snap.device}, ${snap.issues}, ${snap.status}, ${snap.notes}, ${snap.repairCost}, ${snap.amountPaid}, ${snap.technician}, ${t.created || new Date().toISOString()})
      `;
      await insertVersion(t.id, 1, "Restored from backup " + p.id, "restore", snap);
    }
  }

  return {
    restoredCount: target.length,
    backup: safetyBackup,
    tickets: await listTickets(),
  };
}
