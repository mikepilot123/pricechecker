// Parts check — a queue on the shop's MASTER device only (Settings → Devices),
// opened with the owner PIN. Repairs got logged but the parts bought for them
// often weren't, so each finished repair waits in the queue until the owner
// confirms what it used:
//   * "stock":   a part from our stock — one is taken off the inventory sheet
//                (the same path as choosing "stock used" on the repair);
//   * "expense": we paid a supplier — a part bought for it, or the repair
//                sent out (e.g. to Ainsley) — recorded on Expenses (category
//                Parts) with the amount and supplier, linked to the repair;
//   * "none":    nothing spent (labour / software).
// The repair window's "Supplier cost" can correct the amount or supplier
// later, or switch to "nothing spent" (setSupplierCost).
// The answer goes on the repair (parts_check) and in its activity log, so it
// is asked once. Repairs that already have a stock item chosen, or an expense
// that names them, are never asked. Finished or fully paid repairs logged up
// to 30 days before the feature was turned on are asked, so switching it on
// brings up the recent backlog but not the whole history.
import { sql } from "./db.js";
import { getTicketById, updateTicket, recordPartsCheckOnTicket, setPartsCheckOnTicket } from "./tickets.js";
import { addExpense, getExpense, updateExpense, deleteExpense } from "./expenses.js";
import { getMasterSetting } from "./devices.js";

export const PARTS_CHECK_STATUSES = ["Repaired", "Checked Out - Waiting on Client", "Picked Up"];
// Repairs logged up to this long before the master device was set are asked
// too, so the queue starts with the recent backlog rather than empty.
const LOOKBACK_DAYS = 30;
const CHOICES = new Set(["stock", "expense", "none"]);

// A repair is waiting when it is finished (one of PARTS_CHECK_STATUSES) or
// fully paid (its invoice / payments cover the charge), nobody has answered
// for it yet, it has no stock item chosen, and no expense already names it.
async function pendingRows({ countOnly = false } = {}) {
  const master = await getMasterSetting();
  if (!master.since) return [];
  return sql`
    SELECT t.id,
      CASE WHEN t.status = ANY(${PARTS_CHECK_STATUSES}) THEN 'finished' ELSE 'paid' END AS reason
    FROM tickets t
    WHERE t.deleted_at IS NULL
      AND t.parts_check = ''
      AND COALESCE(t.inventory_item_key, '') = ''
      AND t.created_at >= ${master.since}::timestamptz - make_interval(days => ${LOOKBACK_DAYS})
      AND (
        t.status = ANY(${PARTS_CHECK_STATUSES})
        OR (t.status <> 'Cancelled' AND t.status NOT ILIKE 'No Fix%'
            AND COALESCE(t.repair_cost, 0) > 0 AND COALESCE(t.amount_paid, 0) >= t.repair_cost)
      )
      AND NOT EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.deleted_at IS NULL AND position(t.id IN e.notes) > 0
      )
    ORDER BY t.updated_at ASC
    LIMIT ${countOnly ? 1000 : 200}
  `;
}

// The Pending expenses tab also shows the past month's other repairs, so a
// recorded cost can be corrected and work in progress recorded early.
const OVERVIEW_DAYS = 30;
const OVERVIEW_SKIP_STATUSES = ["Received", "Diagnosing", "Cancelled"];

/**
 * Everything the Pending expenses tab shows:
 *   pending:     repairs waiting for an answer (full tickets, as listPartsChecks)
 *   notRecorded: other repairs from the past month with nothing recorded
 *   recorded:    repairs from the past month with an answer
 * notRecorded / recorded rows are light ({ id, partsCheck, expense, ... });
 * the app already has the repairs themselves.
 */
export async function partsCheckOverview() {
  const pending = await listPartsChecks();
  const pendingIds = new Set(pending.map((t) => t.id));
  const rows = await sql`
    SELECT t.id, t.status, t.parts_check, t.inventory_item_key, t.inventory_item_label,
      t.customer_name, t.device, t.issues, t.repair_cost,
      e.id AS expense_id, e.amount AS expense_amount, e.vendor AS expense_vendor,
      (SELECT json_build_object('amount', n.amount, 'vendor', n.vendor, 'category', n.category)
         FROM expenses n
        WHERE n.deleted_at IS NULL AND position(t.id IN n.notes) > 0
        ORDER BY n.created_at DESC LIMIT 1) AS named_expense
    FROM tickets t
    LEFT JOIN expenses e ON e.id = NULLIF(t.parts_check_expense_id, '') AND e.deleted_at IS NULL
    WHERE t.deleted_at IS NULL
      AND t.updated_at >= now() - make_interval(days => ${OVERVIEW_DAYS})
      AND NOT (t.status = ANY(${OVERVIEW_SKIP_STATUSES}))
    ORDER BY t.updated_at DESC
    LIMIT 300
  `;
  const notRecorded = [];
  const recorded = [];
  for (const row of rows) {
    if (pendingIds.has(row.id)) continue;
    const named = typeof row.named_expense === "string" ? JSON.parse(row.named_expense) : row.named_expense;
    const item = {
      id: row.id,
      // Enough of the repair to show it, whether or not the app has the
      // repairs list loaded.
      customerName: row.customer_name || "",
      device: row.device || "",
      issues: row.issues || "",
      repairCost: row.repair_cost == null ? "" : String(row.repair_cost),
      status: row.status || "",
      partsCheck: row.parts_check || "",
      stockItem: row.inventory_item_key ? (row.inventory_item_label || "a stock item") : "",
      expense: row.expense_id ? { id: row.expense_id, amount: Number(row.expense_amount), vendor: row.expense_vendor || "" } : null,
      // An expense entered on Expenses by hand that names this repair.
      namedExpense: !row.expense_id && named ? { amount: Number(named.amount), vendor: named.vendor || "" } : null,
    };
    if (item.partsCheck || item.stockItem || item.namedExpense) recorded.push(item);
    else notRecorded.push(item);
  }
  return { pending, notRecorded, recorded };
}

/** How many repairs are waiting (for the tab's badge). */
export async function countPartsChecks() {
  return (await pendingRows({ countOnly: true })).length;
}

/**
 * Repairs still waiting for a parts check, oldest first. Each carries
 * `partsCheckReason` ("finished" | "paid") and `partsOrders` (parts ordered
 * for that repair, so the cost can be filled in from them).
 */
export async function listPartsChecks() {
  const rows = await pendingRows();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const orders = await sql`
    SELECT ticket_id, vendor, part, quantity, unit_cost
    FROM parts_orders
    WHERE deleted_at IS NULL AND ticket_id = ANY(${ids})
    ORDER BY ordered_at ASC
  `;
  const tickets = [];
  for (const row of rows) {
    const ticket = await getTicketById(row.id);
    if (!ticket) continue;
    ticket.partsCheckReason = row.reason;
    ticket.partsOrders = orders.filter((o) => o.ticket_id === row.id).map((o) => ({
      vendor: o.vendor || "", part: o.part || "", quantity: Number(o.quantity) || 1,
      unitCost: Number(o.unit_cost) || 0,
    }));
    tickets.push(ticket);
  }
  return tickets;
}

const text = (v) => String(v == null ? "" : v).trim();
const money = (v) => {
  const raw = text(v);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const n = Math.round(Number(raw) * 100) / 100;
  return n > 0 ? n : null;
};

/**
 * Records the answer for one repair. Returns { ticket, expense? }.
 * p: { id, choice, inventoryItemKey?, amount?, vendor?, date?, notes? }
 */
export async function recordPartsCheck(p = {}) {
  const id = text(p.id);
  if (!id) throw new Error("Ticket ID is required");
  const choice = text(p.choice);
  if (!CHOICES.has(choice)) throw new Error("Choose stock, bought for it, or no part needed");
  const ticket = await getTicketById(id);
  if (!ticket) throw new Error("Repair not found: " + id);
  if (ticket.partsCheck) throw new Error("This repair's parts check is already done");

  if (choice === "stock") {
    const key = text(p.inventoryItemKey);
    if (!key) throw new Error("Choose the stock item that was used");
    // Takes one off the inventory sheet and notes it on the repair.
    await updateTicket({ id, inventoryItemKey: key });
    const updated = await getTicketById(id);
    const finalTicket = await recordPartsCheckOnTicket(id, {
      choice, summary: `Parts check: used ${updated.inventoryItemLabel || "a part"} from stock`,
    });
    return { ticket: finalTicket };
  }

  if (choice === "expense") {
    const fields = supplierFields(p);
    const expense = await addExpense(supplierExpense(ticket, fields));
    const finalTicket = await recordPartsCheckOnTicket(id, {
      choice, expenseId: expense.id,
      summary: `Parts check: paid ${fields.vendor} TT$${fields.amount.toFixed(2)} for this repair — recorded on Expenses`,
    });
    return { ticket: finalTicket, expense };
  }

  const finalTicket = await recordPartsCheckOnTicket(id, { choice, summary: "Parts check: nothing spent on this repair" });
  return { ticket: finalTicket };
}

// What we paid a supplier for a repair: a part bought for it, or the repair
// itself sent out (e.g. to Ainsley). The supplier's name is required.
function supplierFields(p) {
  const amount = money(p.amount);
  if (amount == null) throw new Error("Enter what we paid the supplier (more than 0)");
  const vendor = text(p.vendor).slice(0, 120);
  if (!vendor) throw new Error("Enter the supplier's name");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text(p.date)) ? text(p.date) : new Date().toISOString().slice(0, 10);
  return { amount, vendor, date, details: text(p.notes).slice(0, 300) };
}
function supplierExpense(ticket, { amount, vendor, date, details }) {
  return {
    date,
    category: "Parts",
    vendor,
    amount: amount.toFixed(2),
    notes: [`Paid for repair #${ticket.id} — ${ticket.device || "device"}${ticket.customerName ? ` (${ticket.customerName})` : ""}`, details].filter(Boolean).join(". "),
  };
}
async function linkedExpense(ticket) {
  if (ticket.partsCheck !== "expense" || !ticket.partsCheckExpenseId) return null;
  try { return await getExpense(ticket.partsCheckExpenseId); } catch (_) { return null; }
}

/** The repair window's "Supplier cost": what (if anything) was paid out. */
export async function getSupplierCost(p = {}) {
  const ticket = await getTicketById(text(p.id));
  if (!ticket) throw new Error("Repair not found: " + text(p.id));
  const expense = await linkedExpense(ticket);
  return {
    partsCheck: ticket.partsCheck,
    stockItem: ticket.partsCheck === "stock" ? (ticket.inventoryItemLabel || "") : "",
    expense: expense ? { id: expense.id, amount: Number(expense.amount), vendor: expense.vendor, date: expense.date } : null,
  };
}

/**
 * Sets or corrects what was paid out for a repair, from the repair window.
 * p: { id, spent: true, amount, vendor, date? } — paid a supplier (adds or
 *      corrects the linked expense)
 *    { id, spent: false } — nothing spent (takes a linked expense off)
 * Works whether or not the repair has been through the queue yet.
 */
export async function setSupplierCost(p = {}) {
  const id = text(p.id);
  const ticket = await getTicketById(id);
  if (!ticket) throw new Error("Repair not found: " + id);
  if (ticket.partsCheck === "stock") throw new Error("This repair used a part from stock — change that on the repair's stock item instead");
  const existing = await linkedExpense(ticket);
  const spent = p.spent === true || p.spent === "true";

  if (!spent) {
    if (existing) await deleteExpense({ id: existing.id });
    const summary = existing
      ? `Supplier cost taken off (was TT$${Number(existing.amount).toFixed(2)}${existing.vendor ? ` to ${existing.vendor}` : ""}) — nothing spent on this repair`
      : "Nothing spent on this repair";
    return { ticket: await setPartsCheckOnTicket(id, { choice: "none", summary }) };
  }

  const fields = supplierFields(p);
  if (existing) {
    const changes = { id: existing.id, amount: fields.amount.toFixed(2), vendor: fields.vendor };
    if (p.date) changes.date = fields.date;
    const expense = await updateExpense(changes);
    const was = `TT$${Number(existing.amount).toFixed(2)}${existing.vendor ? ` to ${existing.vendor}` : ""}`;
    const now = `TT$${fields.amount.toFixed(2)} to ${fields.vendor}`;
    const finalTicket = await setPartsCheckOnTicket(id, { choice: "expense", expenseId: existing.id, summary: `Supplier cost changed: ${was} → ${now}` });
    return { ticket: finalTicket, expense };
  }
  const expense = await addExpense(supplierExpense(ticket, fields));
  const finalTicket = await setPartsCheckOnTicket(id, {
    choice: "expense", expenseId: expense.id,
    summary: `Supplier cost: paid ${fields.vendor} TT$${fields.amount.toFixed(2)} for this repair — recorded on Expenses`,
  });
  return { ticket: finalTicket, expense };
}
