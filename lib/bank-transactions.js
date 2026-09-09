import { randomUUID } from "node:crypto";
import { sql } from "./db.js";

const KINDS = new Set(["deposit", "withdrawal"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function kindFrom(value) {
  const kind = text(value).toLowerCase();
  if (!KINDS.has(kind)) throw new Error("Type must be deposit or withdrawal");
  return kind;
}

function amountFrom(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than zero");
  return Math.round(amount * 100) / 100;
}

function timestampFrom(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("Transaction date is invalid");
  return date.toISOString();
}

function rowToTransaction(row) {
  const amount = Number(row.amount || 0);
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    kind: row.kind,
    amount,
    signedAmount: row.kind === "deposit" ? amount : -amount,
    category: row.category || "",
    reference: row.reference || "",
    notes: row.notes || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function requireTransaction(id) {
  const rows = await sql`SELECT * FROM bank_transactions WHERE id = ${text(id)} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Bank transaction not found");
  return rows[0];
}

export async function listBankTransactions() {
  const rows = await sql`
    SELECT * FROM bank_transactions
    WHERE deleted_at IS NULL
    ORDER BY occurred_at DESC, created_at DESC
  `;
  return rows.map(rowToTransaction);
}

export async function bankAccountSummary() {
  const rows = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE -amount END), 0) AS balance,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'deposit' AND date_trunc('month', occurred_at AT TIME ZONE 'America/Port_of_Spain') = date_trunc('month', now() AT TIME ZONE 'America/Port_of_Spain')), 0) AS deposits_month,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'withdrawal' AND date_trunc('month', occurred_at AT TIME ZONE 'America/Port_of_Spain') = date_trunc('month', now() AT TIME ZONE 'America/Port_of_Spain')), 0) AS withdrawals_month,
      COUNT(*) AS transaction_count,
      MAX(occurred_at) AS last_activity
    FROM bank_transactions
    WHERE deleted_at IS NULL
  `;
  const row = rows[0];
  return {
    balance: Number(row.balance),
    depositsThisMonth: Number(row.deposits_month),
    withdrawalsThisMonth: Number(row.withdrawals_month),
    netChangeThisMonth: Number(row.deposits_month) - Number(row.withdrawals_month),
    transactionCount: Number(row.transaction_count),
    lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : null,
  };
}

export async function addBankTransaction(input = {}) {
  const id = `BANK_${randomUUID()}`;
  const kind = kindFrom(input.kind);
  const amount = amountFrom(input.amount);
  const occurredAt = timestampFrom(input.occurredAt);
  const category = text(input.category);
  const reference = text(input.reference);
  const notes = text(input.notes);
  const rows = await sql`
    INSERT INTO bank_transactions (id, occurred_at, kind, amount, category, reference, notes)
    VALUES (${id}, ${occurredAt}, ${kind}, ${amount}, ${category}, ${reference}, ${notes})
    RETURNING *
  `;
  return rowToTransaction(rows[0]);
}

export async function updateBankTransaction(input = {}) {
  const current = await requireTransaction(input.id);
  const kind = input.kind == null ? current.kind : kindFrom(input.kind);
  const amount = input.amount == null ? Number(current.amount) : amountFrom(input.amount);
  const occurredAt = input.occurredAt == null ? current.occurred_at : timestampFrom(input.occurredAt);
  const category = input.category == null ? current.category : text(input.category);
  const reference = input.reference == null ? current.reference : text(input.reference);
  const notes = input.notes == null ? current.notes : text(input.notes);
  const rows = await sql`
    UPDATE bank_transactions SET occurred_at = ${occurredAt}, kind = ${kind}, amount = ${amount},
      category = ${category}, reference = ${reference}, notes = ${notes}, updated_at = now()
    WHERE id = ${current.id} AND deleted_at IS NULL
    RETURNING *
  `;
  return rowToTransaction(rows[0]);
}

export async function deleteBankTransaction(input = {}) {
  const current = await requireTransaction(input.id);
  await sql`UPDATE bank_transactions SET deleted_at = now(), updated_at = now() WHERE id = ${current.id}`;
  return current.id;
}
