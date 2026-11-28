// Parts check — a queue on the shop's MASTER device only (Settings → Devices),
// opened with the owner PIN. Repairs got logged but the parts bought for them
// often weren't, so each finished repair waits in the queue until the owner
// confirms what it used:
//   * "stock":   a part from our stock — one is taken off the inventory sheet
//                (the same path as choosing "stock used" on the repair);
//   * "expense": a part bought for it — recorded on Expenses (category Parts),
//                linked to the repair;
//   * "none":    no part needed (labour / software).
// The answer goes on the repair (parts_check) and in its activity log, so it
// is asked once. Repairs that already have a stock item chosen, or an expense
// that names them, are never asked. Finished or fully paid repairs logged up
// to 30 days before the feature was turned on are asked, so switching it on
// brings up the recent backlog but not the whole history.
import { sql } from "./db.js";
import { getTicketById, updateTicket, recordPartsCheckOnTicket } from "./tickets.js";
import { addExpense } from "./expenses.js";
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
    const amount = money(p.amount);
    if (amount == null) throw new Error("Enter what the part cost (more than 0)");
    const vendor = text(p.vendor).slice(0, 120);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text(p.date)) ? text(p.date) : new Date().toISOString().slice(0, 10);
    const details = text(p.notes).slice(0, 300);
    const expense = await addExpense({
      date,
      category: "Parts",
      vendor,
      amount: amount.toFixed(2),
      notes: [`Part for repair #${id} — ${ticket.device || "device"}${ticket.customerName ? ` (${ticket.customerName})` : ""}`, details].filter(Boolean).join(". "),
    });
    const finalTicket = await recordPartsCheckOnTicket(id, {
      choice, expenseId: expense.id,
      summary: `Parts check: part bought for this repair — TT$${amount.toFixed(2)}${vendor ? ` from ${vendor}` : ""} recorded on Expenses`,
    });
    return { ticket: finalTicket, expense };
  }

  const finalTicket = await recordPartsCheckOnTicket(id, { choice, summary: "Parts check: no part needed" });
  return { ticket: finalTicket };
}
