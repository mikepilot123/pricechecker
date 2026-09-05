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
  if (isNaN(d)) throw new Error("Collection date is invalid");
  return d.toISOString();
}

function boolFrom(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function amountFrom(value) {
  const n = Number(value);
  if (!isFinite(n) || n < 0 || n > 9999999999.99) throw new Error("Expense amount must be a valid non-negative number");
  return (Math.round(n * 100) / 100).toFixed(2);
}

function cents(value) { return Math.round(Number(value || 0) * 100); }
function uid() { return "EC" + crypto.randomUUID(); }

function rowToExpense(row) {
  const amount = Number(row.amount || 0);
  // NULL identifies records written before partial collections existed. Keep
  // their all-or-nothing state, and retain it as a legacy receipt on first edit.
  const collectedAmount = row.reclaimed_amount == null
    ? (row.reclaimed_at ? amount : 0) : Number(row.reclaimed_amount);
  const collections = row.reclaimed_amount == null && row.reclaimed_at && amount > 0
    ? [{ id: "legacy-" + row.id, amount, collectedAt: new Date(row.reclaimed_at).toISOString(), notes: "Previously marked collected" }]
    : (row.reclaim_collections || []);
  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    date: row.date ? dateFrom(row.date) : "",
    category: row.category || "Other",
    vendor: row.vendor || "",
    amount,
    notes: row.notes || "",
    cashReclaim: !!row.cash_reclaim,
    reclaimFrom: row.reclaim_from || "",
    reclaimDueAt: row.reclaim_due_at ? new Date(row.reclaim_due_at).toISOString() : null,
    reclaimedAt: row.reclaimed_at ? new Date(row.reclaimed_at).toISOString() : null,
    collectedAmount,
    remainingAmount: Math.max(0, cents(amount) - cents(collectedAmount)) / 100,
    collections,
  };
}

export const RECLAIM_REMINDER_PREFIX = "CASHBACK:";

// Read the expense inside the transaction instead of passing a stale object
// to a later upsert. Collections and their reminder commit together.
function reminderQueries(id) {
  const reminderId = RECLAIM_REMINDER_PREFIX + id;
  return [
    sql`UPDATE reminders SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
        WHERE id = ${reminderId} AND EXISTS (
          SELECT 1 FROM expenses WHERE id = ${id} AND (NOT cash_reclaim OR deleted_at IS NOT NULL)
        )`,
    sql`
      INSERT INTO reminders (id, title, notes, due_at, done, done_at, priority, kind, amount, expense_id)
      SELECT ${reminderId},
        'Collect $' || (GREATEST(0, amount - COALESCE(reclaimed_amount, CASE WHEN reclaimed_at IS NOT NULL THEN amount ELSE 0 END))::numeric(12,2))::text
          || ' cash back from ' || COALESCE(NULLIF(reclaim_from, ''), 'the other business'),
        'Paid in cash for ' || category || CASE WHEN vendor <> '' THEN ' — ' || vendor ELSE '' END
          || ' on ' || date::text || '. ' || notes,
        reclaim_due_at, reclaimed_at IS NOT NULL, reclaimed_at, '', 'cash_reclaim',
        GREATEST(0, amount - COALESCE(reclaimed_amount, CASE WHEN reclaimed_at IS NOT NULL THEN amount ELSE 0 END)), id
      FROM expenses WHERE id = ${id} AND cash_reclaim AND deleted_at IS NULL
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, notes = EXCLUDED.notes, due_at = EXCLUDED.due_at,
        done = EXCLUDED.done, done_at = EXCLUDED.done_at, kind = EXCLUDED.kind,
        amount = EXCLUDED.amount, expense_id = EXCLUDED.expense_id,
        deleted_at = NULL, updated_at = now()
    `,
  ];
}

async function getExpense(id) {
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  return rowToExpense(rows[0]);
}

export async function listExpenses() {
  const rows = await sql`SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC`;
  return rows.map(rowToExpense);
}

export async function addExpense(p) {
  const id = text(p.id) || "E" + crypto.randomUUID();
  const cashReclaim = boolFrom(p.cashReclaim);
  const amount = Number(amountFrom(p.amount));
  const reclaimedAt = cashReclaim && boolFrom(p.reclaimed) ? new Date().toISOString() : null;
  const collections = reclaimedAt && amount > 0
    ? [{ id: uid(), amount, collectedAt: reclaimedAt, notes: "Marked collected" }] : [];
  await sql.transaction([
    sql`
      INSERT INTO expenses (id, date, category, vendor, amount, notes, cash_reclaim, reclaim_from, reclaim_due_at, reclaimed_at, reclaimed_amount, reclaim_collections)
      VALUES (${id}, ${dateFrom(p.date)}, ${text(p.category) || "Other"}, ${text(p.vendor)}, ${amount}, ${text(p.notes)},
        ${cashReclaim}, ${cashReclaim ? text(p.reclaimFrom) : ""}, ${cashReclaim ? timestampFrom(p.reclaimDueAt) : null},
        ${reclaimedAt}, ${reclaimedAt ? amount : 0}, ${JSON.stringify(collections)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    ...reminderQueries(id),
  ]);
  return getExpense(id);
}

// Optimistic locking makes a collection atomic with the balance and history.
// A second device retries against the new balance; it cannot overwrite a
// receipt, over-collect, or restore an expense deleted in the meantime.
async function changeExpense(id, change) {
  if (!id) throw new Error("Expense ID is required");
  for (let attempt = 0; attempt < 4; attempt++) {
    const [row] = await sql`SELECT *, xmin::text AS revision FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
    if (!row) throw new Error("Expense not found: " + id);
    const expense = rowToExpense(row);
    change(expense);
    const collected = expense.collections.filter((entry) => !entry.voidedAt).reduce((sum, entry) => sum + cents(entry.amount), 0);
    if (collected > cents(expense.amount)) throw new Error("Expense amount cannot be less than the amount already collected. Undo the incorrect collection first.");
    expense.collectedAmount = collected / 100;
    expense.reclaimedAt = expense.cashReclaim && collected >= cents(expense.amount)
      ? (expense.reclaimedAt || new Date().toISOString()) : null;
    const [updated] = await sql.transaction([
      sql`
        UPDATE expenses SET date = ${expense.date}, category = ${expense.category}, vendor = ${expense.vendor},
          amount = ${expense.amount}, notes = ${expense.notes}, cash_reclaim = ${expense.cashReclaim},
          reclaim_from = ${expense.reclaimFrom}, reclaim_due_at = ${expense.reclaimDueAt},
          reclaimed_at = ${expense.reclaimedAt}, reclaimed_amount = ${expense.collectedAmount},
          reclaim_collections = ${JSON.stringify(expense.collections)}::jsonb, updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL AND xmin::text = ${row.revision}
        RETURNING *
      `,
      ...reminderQueries(id),
    ]);
    if (updated.length) return rowToExpense(updated[0]);
  }
  throw new Error("This expense changed on another device. Refresh and try again.");
}

function settleExpense(expense, at = new Date().toISOString()) {
  const remaining = cents(expense.amount) - cents(expense.collectedAmount);
  if (remaining > 0) expense.collections.push({ id: uid(), amount: remaining / 100, collectedAt: at, notes: "Remaining balance collected" });
}

function undoLastCollection(expense) {
  const last = expense.collections.filter((entry) => !entry.voidedAt).at(-1);
  if (last) last.voidedAt = new Date().toISOString();
  expense.reclaimedAt = null;
}

export async function updateExpense(p) {
  return changeExpense(text(p.id), (expense) => {
    const wasCollected = !!expense.reclaimedAt;
    if (p.date != null) expense.date = dateFrom(p.date);
    if (p.category != null) expense.category = text(p.category) || "Other";
    if (p.vendor != null) expense.vendor = text(p.vendor);
    if (p.amount != null) expense.amount = Number(amountFrom(p.amount));
    if (p.notes != null) expense.notes = text(p.notes);
    if (p.cashReclaim != null) expense.cashReclaim = boolFrom(p.cashReclaim);
    if (p.reclaimFrom != null) expense.reclaimFrom = text(p.reclaimFrom);
    if (p.reclaimDueAt !== undefined) expense.reclaimDueAt = timestampFrom(p.reclaimDueAt);
    // Compatibility for existing clients: a false checkbox on a PARTIAL
    // expense is not an instruction to erase the money already received.
    if (expense.cashReclaim && p.reclaimed != null) {
      if (boolFrom(p.reclaimed)) settleExpense(expense);
      else if (wasCollected) undoLastCollection(expense);
    }
  });
}

export async function addExpenseCollection(p) {
  const collectionId = text(p.collectionId);
  if (!collectionId || collectionId.length > 100) throw new Error("Collection ID is required");
  const raw = text(p.amount);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || cents(raw) <= 0) throw new Error("Enter a collection amount greater than zero, with at most two decimal places.");
  const amount = Number(amountFrom(raw));
  const collectedAt = timestampFrom(p.collectedAt) || new Date().toISOString();
  const notes = text(p.notes);
  return changeExpense(text(p.id), (expense) => {
    const existing = expense.collections.find((entry) => entry.id === collectionId);
    if (existing) {
      if (cents(existing.amount) !== cents(amount) || existing.notes !== notes) throw new Error("This collection was already saved with different details. Close and reopen collections to record another payment.");
      return; // Also safe after undo: retrying never resurrects a receipt.
    }
    if (!expense.cashReclaim) throw new Error("This expense is not marked as cash to collect back.");
    if (cents(amount) > cents(expense.remainingAmount)) throw new Error("Collection exceeds the remaining balance of $" + expense.remainingAmount.toFixed(2));
    expense.collections.push({ id: collectionId, amount, collectedAt, notes });
  });
}

export async function undoExpenseCollection(p) {
  const collectionId = text(p.collectionId);
  if (!collectionId) throw new Error("Collection ID is required");
  return changeExpense(text(p.id), (expense) => {
    const entry = expense.collections.find((item) => item.id === collectionId);
    if (!entry) throw new Error("Collection not found");
    if (!entry.voidedAt) entry.voidedAt = new Date().toISOString();
    expense.reclaimedAt = null;
  });
}

// Reminder completion collects only the remaining balance. Reopening undoes
// the last receipt, keeping any earlier partial payments intact.
export async function setExpenseReclaimed(expenseId, reclaimed, at) {
  return changeExpense(text(expenseId), (expense) => {
    if (!expense.cashReclaim) return;
    if (reclaimed) settleExpense(expense, at);
    else if (expense.reclaimedAt) undoLastCollection(expense);
  });
}

export async function deleteExpense(p) {
  const id = text(p.id);
  if (!id) throw new Error("Expense ID is required");
  await getExpense(id);
  await sql.transaction([
    sql`UPDATE expenses SET deleted_at = now(), updated_at = now() WHERE id = ${id}`,
    ...reminderQueries(id),
  ]);
  return id;
}
