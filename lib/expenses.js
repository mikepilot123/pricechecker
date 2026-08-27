import { sql } from "./db.js";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function dateFrom(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Expense date must be YYYY-MM-DD");
  return raw;
}

function timestampFrom(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error("Expense collect-by date is invalid");
  return d.toISOString();
}

function boolFrom(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function amountFrom(value) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new Error("Expense amount must be a non-negative number");
  return (Math.round(n * 100) / 100).toFixed(2);
}

function rowToExpense(row) {
  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    date: row.date ? dateFrom(row.date) : "",
    category: row.category || "Other",
    vendor: row.vendor || "",
    amount: row.amount == null ? 0 : Number(row.amount),
    notes: row.notes || "",
    cashReclaim: !!row.cash_reclaim,
    reclaimFrom: row.reclaim_from || "",
    reclaimDueAt: row.reclaim_due_at ? new Date(row.reclaim_due_at).toISOString() : null,
    reclaimedAt: row.reclaimed_at ? new Date(row.reclaimed_at).toISOString() : null,
  };
}

// A cash-reclaim expense is mirrored into one reminder with a derived id, so
// the money owed back shows up in the Reminders tab and the on-screen alerts
// without staff having to write the reminder by hand. The expense row stays
// the source of truth; this rewrites the reminder to match it.
export const RECLAIM_REMINDER_PREFIX = "CASHBACK:";

function reclaimReminderId(expenseId) {
  return RECLAIM_REMINDER_PREFIX + expenseId;
}

function moneyLabel(amount) {
  return "$" + Number(amount || 0).toFixed(2);
}

async function syncReclaimReminder(expense) {
  const id = reclaimReminderId(expense.id);
  if (!expense.cashReclaim) {
    // Un-ticking the box (or deleting the expense) retires the reminder
    // rather than leaving an orphan nagging about money nobody owes.
    await sql`
      UPDATE reminders
      SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return;
  }
  const who = expense.reclaimFrom || "the other business";
  const title = `Collect ${moneyLabel(expense.amount)} cash back from ${who}`;
  const notes = [
    `Paid in cash for ${expense.category || "an expense"}${expense.vendor ? " — " + expense.vendor : ""} on ${expense.date}.`,
    expense.notes,
  ].filter(Boolean).join(" ");
  const done = !!expense.reclaimedAt;
  await sql`
    INSERT INTO reminders (id, title, notes, due_at, done, done_at, priority, kind, amount, expense_id)
    VALUES (${id}, ${title}, ${notes}, ${expense.reclaimDueAt}, ${done}, ${expense.reclaimedAt}, '', 'cash_reclaim', ${expense.amount}, ${expense.id})
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        notes = EXCLUDED.notes,
        due_at = EXCLUDED.due_at,
        done = EXCLUDED.done,
        done_at = EXCLUDED.done_at,
        priority = EXCLUDED.priority,
        kind = EXCLUDED.kind,
        amount = EXCLUDED.amount,
        expense_id = EXCLUDED.expense_id,
        deleted_at = NULL,
        updated_at = now()
  `;
}

async function getExpense(id) {
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  return rowToExpense(rows[0]);
}

export async function listExpenses() {
  const rows = await sql`SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC`;
  return rows.map(rowToExpense);
}

export async function addExpense(p) {
  // Client-supplied ids let old localStorage records migrate without
  // duplicating on retry; ON CONFLICT makes the migration idempotent.
  const id = text(p.id) || "E" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const cashReclaim = boolFrom(p.cashReclaim);
  await sql`
    INSERT INTO expenses (id, date, category, vendor, amount, notes, cash_reclaim, reclaim_from, reclaim_due_at, reclaimed_at)
    VALUES (
      ${id},
      ${dateFrom(p.date)},
      ${text(p.category) || "Other"},
      ${text(p.vendor)},
      ${amountFrom(p.amount)},
      ${text(p.notes)},
      ${cashReclaim},
      ${cashReclaim ? text(p.reclaimFrom) : ""},
      ${cashReclaim ? timestampFrom(p.reclaimDueAt) : null},
      ${cashReclaim && boolFrom(p.reclaimed) ? new Date().toISOString() : null}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  const expense = await getExpense(id);
  await syncReclaimReminder(expense);
  return expense;
}

export async function updateExpense(p) {
  const id = text(p.id);
  if (!id) throw new Error("Expense ID is required");
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  const current = rows[0];
  const cashReclaim = p.cashReclaim != null ? boolFrom(p.cashReclaim) : !!current.cash_reclaim;
  // "reclaimed" is a tri-state on the way in: absent means "leave it alone",
  // which is what an ordinary edit of the amount or vendor should do.
  let reclaimedAt = current.reclaimed_at;
  if (p.reclaimed != null) reclaimedAt = boolFrom(p.reclaimed) ? (current.reclaimed_at || new Date().toISOString()) : null;
  if (!cashReclaim) reclaimedAt = null;
  await sql`
    UPDATE expenses
    SET date = ${p.date != null ? dateFrom(p.date) : dateFrom(current.date)},
        category = ${p.category != null ? (text(p.category) || "Other") : current.category},
        vendor = ${p.vendor != null ? text(p.vendor) : current.vendor},
        amount = ${p.amount != null ? amountFrom(p.amount) : current.amount},
        notes = ${p.notes != null ? text(p.notes) : current.notes},
        cash_reclaim = ${cashReclaim},
        reclaim_from = ${!cashReclaim ? "" : (p.reclaimFrom != null ? text(p.reclaimFrom) : current.reclaim_from)},
        reclaim_due_at = ${!cashReclaim ? null : (p.reclaimDueAt !== undefined ? timestampFrom(p.reclaimDueAt) : current.reclaim_due_at)},
        reclaimed_at = ${reclaimedAt},
        updated_at = now()
    WHERE id = ${id}
  `;
  const expense = await getExpense(id);
  await syncReclaimReminder(expense);
  return expense;
}

// Called from lib/reminders.js when a "CASHBACK:" reminder is ticked off, so
// collecting the cash from the Reminders tab (or an alert popup) settles the
// expense too. Writes the expense directly rather than going through
// updateExpense() — that would re-sync the reminder mid-update.
export async function setExpenseReclaimed(expenseId, reclaimed, at) {
  await sql`
    UPDATE expenses
    SET reclaimed_at = ${reclaimed ? (at || new Date().toISOString()) : null}, updated_at = now()
    WHERE id = ${expenseId} AND deleted_at IS NULL AND cash_reclaim = TRUE
  `;
}

export async function deleteExpense(p) {
  const id = text(p.id);
  if (!id) throw new Error("Expense ID is required");
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  await sql`UPDATE expenses SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  await sql`
    UPDATE reminders
    SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE id = ${reclaimReminderId(id)} AND deleted_at IS NULL
  `;
  return id;
}
