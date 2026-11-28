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
// is asked once. Repairs that already have a stock item chosen are never
// asked. Only repairs logged from a week before the feature was turned on
// are asked, so switching it on doesn't bring up the whole history.
import { sql } from "./db.js";
import { getTicketById, updateTicket, recordPartsCheckOnTicket } from "./tickets.js";
import { addExpense } from "./expenses.js";
import { getMasterSetting } from "./devices.js";

export const PARTS_CHECK_STATUSES = ["Repaired", "Checked Out - Waiting on Client", "Picked Up"];
const LOOKBACK_DAYS = 7;
const CHOICES = new Set(["stock", "expense", "none"]);

/** Finished repairs still waiting for a parts check, oldest first. */
export async function listPartsChecks() {
  const master = await getMasterSetting();
  if (!master.since) return [];
  const rows = await sql`
    SELECT id FROM tickets
    WHERE deleted_at IS NULL
      AND status = ANY(${PARTS_CHECK_STATUSES})
      AND parts_check = ''
      AND inventory_item_key = ''
      AND created_at >= ${master.since}::timestamptz - make_interval(days => ${LOOKBACK_DAYS})
    ORDER BY updated_at ASC
    LIMIT 200
  `;
  const tickets = [];
  for (const row of rows) {
    const ticket = await getTicketById(row.id);
    if (ticket) tickets.push(ticket);
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
