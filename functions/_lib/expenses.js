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
  };
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
  await sql`
    INSERT INTO expenses (id, date, category, vendor, amount, notes)
    VALUES (
      ${id},
      ${dateFrom(p.date)},
      ${text(p.category) || "Other"},
      ${text(p.vendor)},
      ${amountFrom(p.amount)},
      ${text(p.notes)}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return getExpense(id);
}

export async function updateExpense(p) {
  const id = text(p.id);
  if (!id) throw new Error("Expense ID is required");
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  const current = rows[0];
  await sql`
    UPDATE expenses
    SET date = ${p.date != null ? dateFrom(p.date) : dateFrom(current.date)},
        category = ${p.category != null ? (text(p.category) || "Other") : current.category},
        vendor = ${p.vendor != null ? text(p.vendor) : current.vendor},
        amount = ${p.amount != null ? amountFrom(p.amount) : current.amount},
        notes = ${p.notes != null ? text(p.notes) : current.notes},
        updated_at = now()
    WHERE id = ${id}
  `;
  return getExpense(id);
}

export async function deleteExpense(p) {
  const id = text(p.id);
  if (!id) throw new Error("Expense ID is required");
  const rows = await sql`SELECT * FROM expenses WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Expense not found: " + id);
  await sql`UPDATE expenses SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  return id;
}
