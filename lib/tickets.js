import { sql } from "./db.js";
import { consumeInventoryItem, restockInventoryItem, inventoryLabelFromKey } from "./inventory.js";
import { upsertCustomerFromTicket } from "./customers.js";

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

function inventoryItemKeyFrom(p) {
  return String(p.inventoryItemKey != null ? p.inventoryItemKey : (p.inventory_item_key || "")).trim();
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
    inventoryItemKey: row.inventory_item_key || "",
    inventoryItemLabel: row.inventory_item_label || "",
    inventorySection: row.inventory_section || "",
    inventoryQuantityDelta: row.inventory_quantity_delta || 0,
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
    inventoryItemKey: row.inventory_item_key || "",
    inventoryItemLabel: row.inventory_item_label || "",
    inventorySection: row.inventory_section || "",
    inventoryQuantityDelta: row.inventory_quantity_delta || 0,
    history,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    waitingForPartsSince: row.waiting_for_parts_since ? new Date(row.waiting_for_parts_since).toISOString() : null,
    partsOrdered: !!row.parts_ordered,
  };
}

// ---- Monthly sales ledger ---------------------------------------------------
// Revenue is recognized only for tickets that reach "Picked Up" — the same
// definition the Completed Repairs tab uses (assets/intake.js filters that
// list to status === "Picked Up"), not at intake. Each ticket's completion
// month is pinned in tickets.sales_month_key the moment it's first marked
// Picked Up, so later repair-cost corrections (or the ticket being
// un-completed) adjust the correct month even if that's no longer "now".
// Once credited, a month's total is never reversed by delete/clear/restore —
// see lib/db.js's ensureSchema() for the table, and rebuildMonthlySales()
// below for recomputing the whole ledger from scratch if it's ever needed.
function monthKeyFrom(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function adjustMonthlySales(monthKey, salesDelta, countDelta) {
  if (!monthKey || (!salesDelta && !countDelta)) return;
  await sql`
    INSERT INTO monthly_sales (month_key, total_sales, ticket_count, updated_at)
    VALUES (${monthKey}, ${salesDelta}, ${countDelta}, now())
    ON CONFLICT (month_key) DO UPDATE SET
      total_sales = monthly_sales.total_sales + ${salesDelta},
      ticket_count = monthly_sales.ticket_count + ${countDelta},
      updated_at = now()
  `;
}

export async function listMonthlySales({ months = 24 } = {}) {
  const rows = await sql`
    SELECT month_key, total_sales, ticket_count
    FROM monthly_sales
    ORDER BY month_key DESC
    LIMIT ${months}
  `;
  return rows.map((row) => ({
    monthKey: row.month_key,
    totalSales: row.total_sales == null ? 0 : Number(row.total_sales),
    ticketCount: row.ticket_count || 0,
  }));
}

// Recomputes the entire ledger from the tickets table, gated strictly on
// status = 'Picked Up' (matching Completed Repairs, including tickets later
// soft-deleted/cleared — a completed sale stays counted). Backfills
// sales_month_key for any already-Picked-Up ticket that doesn't have one yet
// (pre-dates this column), using updated_at as the best available proxy for
// its completion date. Safe to call any time — e.g. after a definition
// change like this one, or to audit/repair the ledger.
export async function rebuildMonthlySales() {
  await sql`
    UPDATE tickets
    SET sales_month_key = to_char(updated_at, 'YYYY-MM')
    WHERE status = 'Picked Up' AND sales_month_key IS NULL
  `;
  await sql`TRUNCATE monthly_sales`;
  await sql`
    INSERT INTO monthly_sales (month_key, total_sales, ticket_count, updated_at)
    SELECT sales_month_key,
           SUM(repair_cost)::numeric(12, 2) AS total_sales,
           COUNT(*)::int AS ticket_count,
           now()
    FROM tickets
    WHERE status = 'Picked Up' AND sales_month_key IS NOT NULL AND repair_cost IS NOT NULL
    GROUP BY sales_month_key
  `;
  return listMonthlySales();
}

async function recordInventoryMovement(ticketId, movement, reason) {
  if (!movement || !movement.key) return;
  await sql`
    INSERT INTO inventory_movements (ticket_id, inventory_item_key, inventory_item_label, inventory_section, delta, reason)
    VALUES (${ticketId}, ${movement.key}, ${movement.label || ""}, ${movement.section || ""}, ${movement.delta}, ${reason || ""})
  `;
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
  const inventoryItemKey = inventoryItemKeyFrom(p);
  let inventoryMovement = null;
  if (inventoryItemKey) inventoryMovement = await consumeInventoryItem(inventoryItemKey, id);
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
    inventoryItemKey,
    inventoryItemLabel: inventoryMovement ? inventoryMovement.label : "",
    inventorySection: inventoryMovement ? inventoryMovement.section : "",
    inventoryQuantityDelta: inventoryMovement ? inventoryMovement.delta : 0,
  };

  const waitingForPartsSince = status === "Waiting for Parts" ? new Date().toISOString() : null;

  try {
    await sql`
      INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician, inventory_item_key, inventory_item_label, inventory_section, inventory_quantity_delta, waiting_for_parts_since)
      VALUES (${id}, ${snapshot.customerName}, ${snapshot.phone}, ${snapshot.email}, ${snapshot.device}, ${snapshot.issues}, ${snapshot.status}, ${snapshot.notes}, ${snapshot.repairCost}, ${snapshot.amountPaid}, ${snapshot.technician}, ${snapshot.inventoryItemKey}, ${snapshot.inventoryItemLabel}, ${snapshot.inventorySection}, ${snapshot.inventoryQuantityDelta}, ${waitingForPartsSince})
    `;
    await insertVersion(id, 1, `Logged — ${status}`, "create", snapshot);
    await recordInventoryMovement(id, inventoryMovement, "ticket create");
    // Revenue isn't recognized at intake — see updateTicket()'s ledger block:
    // a ticket only credits monthly_sales once it reaches "Picked Up", same
    // definition the Completed Repairs tab uses.
  } catch (err) {
    if (inventoryMovement) await restockInventoryItem(inventoryMovement.key, id).catch(() => {});
    throw err;
  }
  try {
    await upsertCustomerFromTicket(snapshot);
  } catch (err) {
    console.error("Customer directory upsert failed:", err);
  }
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
  const inventoryChanged = p.inventoryItemKey != null || p.inventory_item_key != null;
  const oldInventoryKey = current.inventory_item_key || "";
  const inventoryItemKey = inventoryChanged ? inventoryItemKeyFrom(p) : oldInventoryKey;
  let inventoryItemLabel = current.inventory_item_label || "";
  let inventorySection = current.inventory_section || "";
  let inventoryQuantityDelta = current.inventory_quantity_delta || 0;
  let newInventoryMovement = null;
  let oldInventoryMovement = null;

  if (inventoryChanged && inventoryItemKey !== oldInventoryKey) {
    if (inventoryItemKey) {
      newInventoryMovement = await consumeInventoryItem(inventoryItemKey, p.id);
      inventoryItemLabel = newInventoryMovement.label || inventoryLabelFromKey(inventoryItemKey);
      inventorySection = newInventoryMovement.section || "";
      inventoryQuantityDelta = newInventoryMovement.delta;
    } else {
      inventoryItemLabel = "";
      inventorySection = "";
      inventoryQuantityDelta = 0;
    }
    if (oldInventoryKey) {
      try {
        oldInventoryMovement = await restockInventoryItem(oldInventoryKey, p.id);
      } catch (err) {
        if (newInventoryMovement) await restockInventoryItem(newInventoryMovement.key, p.id).catch(() => {});
        throw err;
      }
    }
  }

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
  if (inventoryChanged && inventoryItemKey !== oldInventoryKey) {
    lines.push(`Inventory item: ${inventoryItemLabel || "No stock item used"}`);
  }

  // "Order parts" reminder: start the clock the moment a ticket enters
  // Waiting for Parts, clear it the moment it leaves, and reset the
  // parts_ordered flag on each fresh wait cycle. A staff member can also
  // toggle parts_ordered directly (independent of a status change) while
  // still in that status, to quiet the reminder once parts are ordered.
  const wasWaitingForParts = current.status === "Waiting for Parts";
  const isWaitingForParts = status === "Waiting for Parts";
  let waitingForPartsSince = current.waiting_for_parts_since;
  let partsOrdered = !!current.parts_ordered;
  if (!wasWaitingForParts && isWaitingForParts) {
    waitingForPartsSince = new Date().toISOString();
    partsOrdered = false;
  } else if (wasWaitingForParts && !isWaitingForParts) {
    waitingForPartsSince = null;
    partsOrdered = false;
  }
  if (p.partsOrdered != null && isWaitingForParts) {
    const requestedPartsOrdered = !!p.partsOrdered;
    if (requestedPartsOrdered !== partsOrdered) {
      partsOrdered = requestedPartsOrdered;
      lines.push(requestedPartsOrdered ? "Parts ordered" : "Parts ordered — marked not ordered");
    }
  }

  const changed = lines.length > 0;
  const nextVersion = changed ? current.current_version + 1 : current.current_version;

  // Ledger: gated strictly on the Picked Up transition (see the "Monthly
  // sales ledger" comment above for why). Compute the new sales_month_key
  // before writing so it lands in the same UPDATE as everything else.
  const wasPickedUp = current.status === "Picked Up";
  const isPickedUp = status === "Picked Up";
  const oldRepairCost = moneyFrom(current.repair_cost, "Repair cost");
  let salesMonthKey = current.sales_month_key || null;
  if (!wasPickedUp && isPickedUp) {
    salesMonthKey = monthKeyFrom(new Date());
  } else if (wasPickedUp && !isPickedUp) {
    salesMonthKey = null;
  }

  try {
    await sql`
      UPDATE tickets
      SET customer_name = ${customerName}, phone = ${phone}, email = ${email}, device = ${device},
          issues = ${issues}, status = ${status}, notes = ${notes},
          repair_cost = ${repairCost}, amount_paid = ${amountPaid}, technician = ${technician},
          inventory_item_key = ${inventoryItemKey}, inventory_item_label = ${inventoryItemLabel},
          inventory_section = ${inventorySection}, inventory_quantity_delta = ${inventoryQuantityDelta},
          sales_month_key = ${salesMonthKey},
          waiting_for_parts_since = ${waitingForPartsSince}, parts_ordered = ${partsOrdered},
          updated_at = now(), current_version = ${nextVersion}
      WHERE id = ${p.id}
    `;
    if (changed) {
      await insertVersion(p.id, nextVersion, lines.join("; "), "update", {
        customerName, phone, email, device, issues, status, notes, repairCost, amountPaid, technician,
        inventoryItemKey, inventoryItemLabel, inventorySection, inventoryQuantityDelta,
      });
    }
    await recordInventoryMovement(p.id, newInventoryMovement, "ticket update consume");
    await recordInventoryMovement(p.id, oldInventoryMovement, "ticket update restock");

    if (!wasPickedUp && isPickedUp) {
      // Newly completed — credit this month with the final repair cost.
      await adjustMonthlySales(salesMonthKey, repairCost == null ? 0 : Number(repairCost), 1);
    } else if (wasPickedUp && !isPickedUp) {
      // Un-completed after all — reverse the credit from whichever month it
      // was originally recognized in (current.sales_month_key), not "now".
      await adjustMonthlySales(current.sales_month_key, oldRepairCost == null ? 0 : -Number(oldRepairCost), -1);
    } else if (wasPickedUp && isPickedUp && repairCost !== oldRepairCost) {
      // Still completed, just a price correction — adjust the same month.
      const delta = (repairCost == null ? 0 : Number(repairCost)) - (oldRepairCost == null ? 0 : Number(oldRepairCost));
      await adjustMonthlySales(salesMonthKey, delta, 0);
    }
  } catch (err) {
    if (newInventoryMovement) await restockInventoryItem(newInventoryMovement.key, p.id).catch(() => {});
    if (oldInventoryMovement && oldInventoryKey) await consumeInventoryItem(oldInventoryKey, p.id).catch(() => {});
    throw err;
  }
  try {
    await upsertCustomerFromTicket({ customerName, phone, email });
  } catch (err) {
    console.error("Customer directory upsert failed:", err);
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
  let inventoryMovement = null;
  if (current.inventory_item_key) inventoryMovement = await restockInventoryItem(current.inventory_item_key, p.id);
  try {
    await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${p.id}`;
    await insertVersion(p.id, nextVersion, "Deleted", "delete", snapshotFromRow(current));
    await recordInventoryMovement(p.id, inventoryMovement, "ticket delete restock");
  } catch (err) {
    if (inventoryMovement) await consumeInventoryItem(current.inventory_item_key, p.id).catch(() => {});
    throw err;
  }
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
    let inventoryMovement = null;
    if (row.inventory_item_key) inventoryMovement = await restockInventoryItem(row.inventory_item_key, row.id);
    try {
      await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${row.id}`;
      await insertVersion(row.id, nextVersion, "Cleared (bulk delete)", "delete", snapshotFromRow(row));
      await recordInventoryMovement(row.id, inventoryMovement, "bulk clear restock");
    } catch (err) {
      if (inventoryMovement) await consumeInventoryItem(row.inventory_item_key, row.id).catch(() => {});
      throw err;
    }
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
    let inventoryMovement = null;
    if (row.inventory_item_key) inventoryMovement = await restockInventoryItem(row.inventory_item_key, row.id);
    try {
      await sql`UPDATE tickets SET deleted_at = now(), current_version = ${nextVersion} WHERE id = ${row.id}`;
      await insertVersion(row.id, nextVersion, "Removed by backup restore", "delete", snapshotFromRow(row));
      await recordInventoryMovement(row.id, inventoryMovement, "backup restore remove restock");
    } catch (err) {
      if (inventoryMovement) await consumeInventoryItem(row.inventory_item_key, row.id).catch(() => {});
      throw err;
    }
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
      inventoryItemKey: t.inventoryItemKey || "",
      inventoryItemLabel: t.inventoryItemLabel || "",
      inventorySection: t.inventorySection || "",
      inventoryQuantityDelta: Number(t.inventoryQuantityDelta || 0),
    };
    const existingRow = existing[0];
    const oldInventoryKey = existingRow && !existingRow.deleted_at ? existingRow.inventory_item_key || "" : "";
    let consumeMovement = null;
    let restockMovement = null;
    if (snap.inventoryItemKey !== oldInventoryKey) {
      try {
        if (snap.inventoryItemKey) consumeMovement = await consumeInventoryItem(snap.inventoryItemKey, t.id);
        if (oldInventoryKey) restockMovement = await restockInventoryItem(oldInventoryKey, t.id);
      } catch (err) {
        if (consumeMovement) await restockInventoryItem(consumeMovement.key, t.id).catch(() => {});
        throw err;
      }
      if (consumeMovement) {
        snap.inventoryItemLabel = consumeMovement.label || inventoryLabelFromKey(snap.inventoryItemKey);
        snap.inventorySection = consumeMovement.section || snap.inventorySection;
        snap.inventoryQuantityDelta = consumeMovement.delta;
      }
      if (!snap.inventoryItemKey) {
        snap.inventoryItemLabel = "";
        snap.inventorySection = "";
        snap.inventoryQuantityDelta = 0;
      }
    }
    try {
      if (existing.length) {
        const nextVersion = existing[0].current_version + 1;
        await sql`
          UPDATE tickets
          SET customer_name = ${snap.customerName}, phone = ${snap.phone}, email = ${snap.email}, device = ${snap.device},
              issues = ${snap.issues}, status = ${snap.status}, notes = ${snap.notes},
              repair_cost = ${snap.repairCost}, amount_paid = ${snap.amountPaid}, technician = ${snap.technician},
              inventory_item_key = ${snap.inventoryItemKey}, inventory_item_label = ${snap.inventoryItemLabel},
              inventory_section = ${snap.inventorySection}, inventory_quantity_delta = ${snap.inventoryQuantityDelta},
              deleted_at = NULL, updated_at = now(), current_version = ${nextVersion}
          WHERE id = ${t.id}
        `;
        await insertVersion(t.id, nextVersion, "Restored from backup " + p.id, "restore", snap);
      } else {
        await sql`
          INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician, inventory_item_key, inventory_item_label, inventory_section, inventory_quantity_delta, created_at)
          VALUES (${t.id}, ${snap.customerName}, ${snap.phone}, ${snap.email}, ${snap.device}, ${snap.issues}, ${snap.status}, ${snap.notes}, ${snap.repairCost}, ${snap.amountPaid}, ${snap.technician}, ${snap.inventoryItemKey}, ${snap.inventoryItemLabel}, ${snap.inventorySection}, ${snap.inventoryQuantityDelta}, ${t.created || new Date().toISOString()})
        `;
        await insertVersion(t.id, 1, "Restored from backup " + p.id, "restore", snap);
      }
      await recordInventoryMovement(t.id, consumeMovement, "backup restore consume");
      await recordInventoryMovement(t.id, restockMovement, "backup restore restock");
    } catch (err) {
      if (consumeMovement) await restockInventoryItem(consumeMovement.key, t.id).catch(() => {});
      if (restockMovement && oldInventoryKey) await consumeInventoryItem(oldInventoryKey, t.id).catch(() => {});
      throw err;
    }
  }

  return {
    restoredCount: target.length,
    backup: safetyBackup,
    tickets: await listTickets(),
  };
}
