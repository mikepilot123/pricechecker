import { sql } from "./db.js";
import { consumeInventoryItem, restockInventoryItem, inventoryLabelFromKey } from "./inventory.js";
import { upsertCustomerFromTicket } from "./customers.js";
import { addCardPayment, updateCardPayment, voidCardPayment } from "./card-payments.js";

// Keep in sync with assets/intake.js STATUSES.
const STATUSES = [
  "Received",
  "Diagnosing",
  "Waiting for Parts",
  "Part to be Ordered",
  "Part Ordered",
  "In Progress",
  "Repaired",
  "Checked Out - Waiting on Client",
  "No Fix",
  "Picked Up",
  "Cancelled",
];

// Every status where the repair is blocked on a part. The "order parts"
// reminder clock (waiting_for_parts_since) runs across all of them, so
// moving between them — e.g. Waiting for Parts -> Part to be Ordered —
// refines what staff know without restarting the wait.
const PARTS_STATUSES = new Set(["Waiting for Parts", "Part to be Ordered", "Part Ordered"]);
const REPAIR_CHECK_REMINDER_PREFIX = "AUTO_REPAIR_CHECK:";
// Repair-check reminders only fire for tickets stuck in one of these
// statuses — keep in sync with assets/intake.js REPAIR_CHECK_ALERT_STATUSES.
const REPAIR_CHECK_STATUSES = ["Received", "Waiting for Parts"];
// "Stuck" means still in one of the statuses above more than this many days
// after being logged — keep in sync with assets/intake.js REPAIR_CHECK_ALERT_MIN_DAYS.
const REPAIR_CHECK_MIN_DAYS = 2;

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

function dateFrom(value, label) {
  if (value == null || String(value).trim() === "") return null;
  if (value instanceof Date) {
    if (isNaN(value)) throw new Error(`${label} is invalid`);
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const d = new Date(text);
  if (isNaN(d)) throw new Error(`${label} is invalid`);
  return d.toISOString().slice(0, 10);
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
    paymentMethod: row.payment_method || "",
    cardType: row.payment_card_type || "",
    cardPaymentId: row.card_payment_id || "",
    technician: row.technician || "",
    repairDueDate: dateFrom(row.repair_due_date, "Repair due date"),
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
    repairDueDate: row.repair_due_date ? dateFrom(row.repair_due_date, "Repair due date") : "",
    inventoryItemKey: row.inventory_item_key || "",
    inventoryItemLabel: row.inventory_item_label || "",
    inventorySection: row.inventory_section || "",
    inventoryQuantityDelta: row.inventory_quantity_delta || 0,
    history,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    currentVersion: row.current_version || 1,
    waitingForPartsSince: row.waiting_for_parts_since ? new Date(row.waiting_for_parts_since).toISOString() : null,
    partsOrdered: !!row.parts_ordered,
    paymentMethod: row.payment_method || "",
    cardType: row.payment_card_type || "",
    cardPaymentId: row.card_payment_id || "",
  };
}

// ---- Card takings link ------------------------------------------------------
// A repair paid on the card machine is money that lands in someone else's
// account first, so it has to appear in the card takings ledger too. Doing that
// here rather than asking staff to log it twice is the whole point: the ticket
// is the only place the amount is typed, so the two can't disagree.
const PAYMENT_METHODS = ["", "cash", "card", "transfer"];

function paymentMethodFrom(value, fallback = "") {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  return PAYMENT_METHODS.includes(v) ? v : fallback;
}

/**
 * Reconcile a ticket's linked card payment after the ticket has been written.
 * Returns { cardPaymentId, cardType } to store back on the ticket.
 *
 * Deliberately gives up rather than fights when the linked payment has already
 * been collected: that money is part of a payout's arithmetic, and silently
 * rewriting it would make a past transfer stop adding up. The ticket keeps its
 * link, and correcting it becomes a visible decision in the Account tab.
 */
async function syncTicketCardPayment(ticketId, { method, cardType, amountPaid, customerName, existingId }) {
  const amount = amountPaid == null || amountPaid === "" ? 0 : Number(amountPaid);
  const wantsPayment = method === "card" && amount > 0;
  const type = cardType === "credit" ? "credit" : "debit";

  if (existingId) {
    const [row] = await sql`SELECT * FROM card_payments WHERE id = ${existingId} AND deleted_at IS NULL`;
    if (row && (row.payout_id || row.voided_at)) {
      // Already collected or already voided — leave the ledger alone.
      return { cardPaymentId: existingId, cardType: row.card_type || type };
    }
    if (row && wantsPayment) {
      await updateCardPayment({ id: existingId, gross: amount, cardType: type, customer: customerName });
      return { cardPaymentId: existingId, cardType: type };
    }
    if (row) {
      await voidCardPayment({ id: existingId, reason: "Repair is no longer marked as paid by card" });
      return { cardPaymentId: null, cardType: "" };
    }
  }

  if (!wantsPayment) return { cardPaymentId: null, cardType: "" };
  const payment = await addCardPayment({
    gross: amount,
    cardType: type,
    customer: customerName,
    ticketId,
    notes: "From repair " + ticketId,
  });
  return { cardPaymentId: payment.id, cardType: type };
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

/* ---- Internal note log ------------------------------------------------- */
// Separate from tickets.notes on purpose: that field is written at check-in
// and rendered on the customer's invoice (lib/invoices.js), so it can't double
// as a place for staff to jot working notes. These are internal only.
//
// Unlike lead_notes there's no de-duplication here — "Called customer, no
// answer" is a perfectly reasonable thing to write twice on different days,
// and silently dropping the second one would lose real history.
function rowToTicketNote(row) {
  return {
    id: String(row.id),
    ticketId: row.ticket_id,
    note: row.note || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listTicketNotes(ticketId) {
  const id = String(ticketId == null ? "" : ticketId).trim();
  if (!id) throw new Error("Ticket ID is required");
  const rows = await sql`
    SELECT * FROM ticket_notes
    WHERE ticket_id = ${id}
    ORDER BY created_at DESC, id DESC
  `;
  return rows.map(rowToTicketNote);
}

// Every note across every ticket in one query. The nightly Google Sheet
// backup needs all of them, and one request per ticket would be hundreds of
// round trips against a serverless function.
export async function listAllTicketNotes() {
  const rows = await sql`
    SELECT n.* FROM ticket_notes n
    JOIN tickets t ON t.id = n.ticket_id
    WHERE t.deleted_at IS NULL
    ORDER BY n.ticket_id, n.created_at DESC, n.id DESC
  `;
  return rows.map(rowToTicketNote);
}

export async function addTicketNote(p) {
  const id = String(p.ticketId == null ? "" : p.ticketId).trim();
  const note = String(p.note == null ? "" : p.note).trim();
  if (!id) throw new Error("Ticket ID is required");
  if (!note) throw new Error("Note text is required");
  const rows = await sql`SELECT id FROM tickets WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Ticket not found: " + id);
  await sql`INSERT INTO ticket_notes (ticket_id, note) VALUES (${id}, ${note})`;
  // Touch the ticket so devices polling for changes pick the note up.
  await sql`UPDATE tickets SET updated_at = now() WHERE id = ${id}`;
  return listTicketNotes(id);
}

export async function deleteTicketNote(p) {
  const noteId = String(p.noteId == null ? "" : p.noteId).trim();
  const ticketId = String(p.ticketId == null ? "" : p.ticketId).trim();
  if (!noteId) throw new Error("Note ID is required");
  await sql`DELETE FROM ticket_notes WHERE id = ${noteId}`;
  return ticketId ? listTicketNotes(ticketId) : [];
}

async function getTicket(id) {
  const rows = await sql`SELECT * FROM tickets WHERE id = ${id}`;
  if (!rows.length) throw new Error("Ticket not found: " + id);
  return rowToTicket(rows[0]);
}

async function syncRepairCheckReminders() {
  await sql`
    INSERT INTO reminders (id, title, notes, due_at, done, assignee, priority, ticket_id, ticket_label)
    SELECT
      ${REPAIR_CHECK_REMINDER_PREFIX} || t.id,
      'Check overdue repair: ' || COALESCE(NULLIF(t.customer_name, ''), 'Customer') || ' — ' || COALESCE(NULLIF(t.device, ''), 'Device'),
      'This repair has been stuck in ' || t.status || ' for over ' || ${REPAIR_CHECK_MIN_DAYS} || ' days. Check the ticket and update the status or due date.',
      now(),
      FALSE,
      COALESCE(t.technician, ''),
      'repair',
      t.id,
      COALESCE(NULLIF(t.customer_name, ''), 'Customer') || ' — ' || COALESCE(NULLIF(t.device, ''), 'Device')
    FROM tickets t
    WHERE t.deleted_at IS NULL
      AND t.status = ANY(${REPAIR_CHECK_STATUSES})
      AND t.created_at <= now() - (${REPAIR_CHECK_MIN_DAYS} || ' days')::interval
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE reminders r
    SET deleted_at = COALESCE(r.deleted_at, now()),
        updated_at = now()
    WHERE r.id LIKE ${REPAIR_CHECK_REMINDER_PREFIX + "%"}
      AND r.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM tickets t
        WHERE r.id = ${REPAIR_CHECK_REMINDER_PREFIX} || t.id
          AND t.deleted_at IS NULL
          AND t.status = ANY(${REPAIR_CHECK_STATUSES})
          AND t.created_at <= now() - (${REPAIR_CHECK_MIN_DAYS} || ' days')::interval
      )
  `;
}

export async function listTickets({ includeDeleted = false } = {}) {
  await syncRepairCheckReminders();
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
    repairDueDate: dateFrom(p.repairDueDate, "Repair due date"),
    inventoryItemKey,
    inventoryItemLabel: inventoryMovement ? inventoryMovement.label : "",
    inventorySection: inventoryMovement ? inventoryMovement.section : "",
    inventoryQuantityDelta: inventoryMovement ? inventoryMovement.delta : 0,
  };

  const waitingForPartsSince = PARTS_STATUSES.has(status) ? new Date().toISOString() : null;

  try {
    await sql`
      INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician, repair_due_date, inventory_item_key, inventory_item_label, inventory_section, inventory_quantity_delta, waiting_for_parts_since)
      VALUES (${id}, ${snapshot.customerName}, ${snapshot.phone}, ${snapshot.email}, ${snapshot.device}, ${snapshot.issues}, ${snapshot.status}, ${snapshot.notes}, ${snapshot.repairCost}, ${snapshot.amountPaid}, ${snapshot.technician}, ${snapshot.repairDueDate}, ${snapshot.inventoryItemKey}, ${snapshot.inventoryItemLabel}, ${snapshot.inventorySection}, ${snapshot.inventoryQuantityDelta}, ${waitingForPartsSince})
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
  await applyPaymentMethod(id, {
    method: paymentMethodFrom(p.paymentMethod),
    cardType: p.cardType,
    amountPaid: snapshot.amountPaid,
    customerName: snapshot.customerName,
    existingId: null,
  });
  return getTicket(id);
}

/**
 * Write the payment method onto the ticket and reconcile the card takings
 * ledger with it. Split out because addTicket and updateTicket both need it and
 * both do it after their own row is safely written.
 */
async function applyPaymentMethod(ticketId, options) {
  const method = options.method;
  let link = { cardPaymentId: options.existingId || null, cardType: "" };
  try {
    link = await syncTicketCardPayment(ticketId, options);
  } catch (err) {
    // A ledger hiccup must not lose the repair itself — the ticket is the
    // record that matters, and the payment can be logged by hand.
    console.error("Card takings sync failed for ticket " + ticketId + ":", err);
    return;
  }
  await sql`
    UPDATE tickets
    SET payment_method = ${method},
        card_payment_id = ${link.cardPaymentId},
        payment_card_type = ${link.cardType || ""},
        updated_at = now()
    WHERE id = ${ticketId}
  `;
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
  const repairDueDate = p.repairDueDate !== undefined ? dateFrom(p.repairDueDate, "Repair due date") : dateFrom(current.repair_due_date, "Repair due date");
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
  if (repairDueDate !== dateFrom(current.repair_due_date, "Repair due date")) lines.push(`Due date updated to ${repairDueDate || "No due date"}`);
  if (inventoryChanged && inventoryItemKey !== oldInventoryKey) {
    lines.push(`Inventory item: ${inventoryItemLabel || "No stock item used"}`);
  }

  // "Order parts" reminder: start the clock the moment a ticket enters any
  // parts status, clear it the moment it leaves them all, and reset the
  // parts_ordered flag on each fresh wait cycle. A staff member can also
  // toggle parts_ordered directly (independent of a status change) while
  // still in that status, to quiet the reminder once parts are ordered.
  const wasWaitingForParts = PARTS_STATUSES.has(current.status);
  const isWaitingForParts = PARTS_STATUSES.has(status);
  let waitingForPartsSince = current.waiting_for_parts_since;
  let partsOrdered = !!current.parts_ordered;
  if (!wasWaitingForParts && isWaitingForParts) {
    waitingForPartsSince = new Date().toISOString();
    partsOrdered = false;
  } else if (wasWaitingForParts && !isWaitingForParts) {
    waitingForPartsSince = null;
    partsOrdered = false;
  }
  // "Part Ordered" / "Part to be Ordered" state the flag in the status itself,
  // so keep parts_ordered in step whenever a ticket lands on one of them —
  // otherwise the reminder could nag about a ticket already marked ordered.
  if (isWaitingForParts && status !== current.status) {
    if (status === "Part Ordered") partsOrdered = true;
    else if (status === "Part to be Ordered") partsOrdered = false;
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
          repair_due_date = ${repairDueDate},
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
        repairDueDate, inventoryItemKey, inventoryItemLabel, inventorySection, inventoryQuantityDelta,
      });
    }
    await recordInventoryMovement(p.id, newInventoryMovement, "ticket update consume");
    await recordInventoryMovement(p.id, oldInventoryMovement, "ticket update restock");

    // Keep the card takings ledger in step with the amount on the ticket. Only
    // runs when the caller actually said something about how it was paid, so an
    // ordinary status change doesn't disturb an existing ledger row.
    if (p.paymentMethod !== undefined || p.cardType !== undefined) {
      await applyPaymentMethod(p.id, {
        method: paymentMethodFrom(p.paymentMethod, current.payment_method || ""),
        cardType: p.cardType !== undefined ? p.cardType : current.payment_card_type,
        amountPaid,
        customerName,
        existingId: current.card_payment_id,
      });
    } else if (current.card_payment_id && amountPaid !== moneyFrom(current.amount_paid, "Amount paid")) {
      // The amount changed without the method being resent — the linked
      // payment still has to follow, or the ledger quietly overstates.
      await applyPaymentMethod(p.id, {
        method: current.payment_method || "",
        cardType: current.payment_card_type,
        amountPaid,
        customerName,
        existingId: current.card_payment_id,
      });
    }

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
  await syncRepairCheckReminders();
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
  await syncRepairCheckReminders();
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
      repairDueDate: dateFrom(t.repairDueDate, "Repair due date"),
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
              repair_due_date = ${snap.repairDueDate},
              inventory_item_key = ${snap.inventoryItemKey}, inventory_item_label = ${snap.inventoryItemLabel},
              inventory_section = ${snap.inventorySection}, inventory_quantity_delta = ${snap.inventoryQuantityDelta},
              deleted_at = NULL, updated_at = now(), current_version = ${nextVersion}
          WHERE id = ${t.id}
        `;
        await insertVersion(t.id, nextVersion, "Restored from backup " + p.id, "restore", snap);
      } else {
        await sql`
          INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, repair_cost, amount_paid, technician, repair_due_date, inventory_item_key, inventory_item_label, inventory_section, inventory_quantity_delta, created_at)
          VALUES (${t.id}, ${snap.customerName}, ${snap.phone}, ${snap.email}, ${snap.device}, ${snap.issues}, ${snap.status}, ${snap.notes}, ${snap.repairCost}, ${snap.amountPaid}, ${snap.technician}, ${snap.repairDueDate}, ${snap.inventoryItemKey}, ${snap.inventoryItemLabel}, ${snap.inventorySection}, ${snap.inventoryQuantityDelta}, ${t.created || new Date().toISOString()})
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
