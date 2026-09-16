import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { addExpense, updateExpense, deleteExpense } from "./expenses.js";

const KINDS = new Set(["deposit", "withdrawal"]);
const ACCOUNT_TYPES = new Set(["bank", "cash"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function kindFrom(value) {
  const kind = text(value).toLowerCase();
  if (!KINDS.has(kind)) throw new Error("Type must be deposit or withdrawal");
  return kind;
}

function accountTypeFrom(value, fallback = "bank") {
  const type = text(value).toLowerCase() || fallback;
  if (!ACCOUNT_TYPES.has(type)) throw new Error("Account must be bank or cash");
  return type;
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
    accountType: row.account_type || "bank",
    amount,
    signedAmount: row.kind === "deposit" ? amount : -amount,
    category: row.category || "",
    reference: row.reference || "",
    notes: row.notes || "",
    expenseId: row.expense_id || null,
    transferId: row.transfer_id || null,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function linkedExpenseId(transactionId) {
  return `BANKEXP_${transactionId}`;
}

function expenseDetails(transaction) {
  const details = [
    transaction.reference ? `Reference: ${transaction.reference}` : "",
    transaction.notes || "",
  ].filter(Boolean).join(" · ");
  return {
    date: transaction.occurredAt.slice(0, 10),
    category: transaction.accountType === "cash" ? "Cash withdrawal" : "Bank withdrawal",
    vendor: transaction.category || "",
    amount: transaction.amount,
    notes: details,
    cashReclaim: false,
  };
}

async function syncWithdrawalExpense(transaction, previousExpenseId = null) {
  if (transaction.kind !== "withdrawal") {
    if (previousExpenseId) await deleteExpense({ id: previousExpenseId });
    return null;
  }
  const expenseId = previousExpenseId || linkedExpenseId(transaction.id);
  const details = expenseDetails(transaction);
  if (previousExpenseId) await updateExpense({ id: expenseId, ...details });
  else await addExpense({ id: expenseId, ...details });
  return expenseId;
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
      account_type,
      COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE -amount END), 0) AS balance,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'deposit' AND date_trunc('month', occurred_at AT TIME ZONE 'America/Port_of_Spain') = date_trunc('month', now() AT TIME ZONE 'America/Port_of_Spain')), 0) AS deposits_month,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'withdrawal' AND date_trunc('month', occurred_at AT TIME ZONE 'America/Port_of_Spain') = date_trunc('month', now() AT TIME ZONE 'America/Port_of_Spain')), 0) AS withdrawals_month,
      COUNT(*) AS transaction_count,
      MAX(occurred_at) AS last_activity
    FROM bank_transactions
    WHERE deleted_at IS NULL
    GROUP BY account_type
  `;
  const bank = rows.find((row) => row.account_type === "bank");
  const cash = rows.find((row) => row.account_type === "cash");
  const empty = { balance: 0, deposits_month: 0, withdrawals_month: 0, transaction_count: 0, last_activity: null };
  const b = bank || empty;
  const c = cash || empty;
  return {
    // Bank stays the headline figures — Current balance/Deposits/Withdrawals
    // tiles are unchanged in meaning, just now explicitly bank-only.
    balance: Number(b.balance),
    depositsThisMonth: Number(b.deposits_month),
    withdrawalsThisMonth: Number(b.withdrawals_month),
    netChangeThisMonth: Number(b.deposits_month) - Number(b.withdrawals_month),
    transactionCount: Number(b.transaction_count),
    lastActivity: b.last_activity ? new Date(b.last_activity).toISOString() : null,
    // Cash on hand is its own running balance, entirely separate from the
    // bank figures above — a cash deposit never touches the bank balance.
    cash: {
      balance: Number(c.balance),
      depositsThisMonth: Number(c.deposits_month),
      withdrawalsThisMonth: Number(c.withdrawals_month),
      transactionCount: Number(c.transaction_count),
      lastActivity: c.last_activity ? new Date(c.last_activity).toISOString() : null,
    },
  };
}

export async function addBankTransaction(input = {}) {
  const id = `BANK_${randomUUID()}`;
  const kind = kindFrom(input.kind);
  const accountType = accountTypeFrom(input.accountType);
  const amount = amountFrom(input.amount);
  const occurredAt = timestampFrom(input.occurredAt);
  const category = text(input.category);
  const reference = text(input.reference);
  const notes = text(input.notes);
  const transferId = text(input.transferId) || null;
  const rows = await sql`
    INSERT INTO bank_transactions (id, occurred_at, kind, account_type, amount, category, reference, notes, transfer_id)
    VALUES (${id}, ${occurredAt}, ${kind}, ${accountType}, ${amount}, ${category}, ${reference}, ${notes}, ${transferId})
    RETURNING *
  `;
  let transaction = rowToTransaction(rows[0]);
  // A transfer's withdrawal leg isn't a real expense — the money didn't
  // leave the business, it just moved from the till to the bank — so it
  // never gets an auto-created expense row.
  if (transaction.kind === "withdrawal" && !transferId) {
    const expenseId = await syncWithdrawalExpense(transaction);
    const [linked] = await sql`
      UPDATE bank_transactions SET expense_id = ${expenseId}, updated_at = now()
      WHERE id = ${transaction.id} RETURNING *
    `;
    transaction = rowToTransaction(linked);
  }
  return transaction;
}

// Cash physically deposited into the bank is one event, but each ledger only
// knows its own side — so it's recorded as a linked pair: cash goes down,
// bank goes up, by the same amount, at the same moment.
export async function addCashDepositToBank(input = {}) {
  const amount = amountFrom(input.amount);
  const occurredAt = timestampFrom(input.occurredAt);
  const notes = text(input.notes);
  const transferId = randomUUID();
  const withdrawal = await addBankTransaction({
    kind: "withdrawal", accountType: "cash", amount, occurredAt,
    category: "Transfer to bank", notes, transferId,
  });
  const deposit = await addBankTransaction({
    kind: "deposit", accountType: "bank", amount, occurredAt,
    category: "Cash deposit", notes, transferId,
  });
  return { withdrawal, deposit };
}

export async function updateBankTransaction(input = {}, { cascade = true } = {}) {
  const current = await requireTransaction(input.id);
  const kind = input.kind == null ? current.kind : kindFrom(input.kind);
  const accountType = input.accountType == null ? (current.account_type || "bank") : accountTypeFrom(input.accountType);
  const amount = input.amount == null ? Number(current.amount) : amountFrom(input.amount);
  const occurredAt = input.occurredAt == null ? current.occurred_at : timestampFrom(input.occurredAt);
  const category = input.category == null ? current.category : text(input.category);
  const reference = input.reference == null ? current.reference : text(input.reference);
  const notes = input.notes == null ? current.notes : text(input.notes);
  const rows = await sql`
    UPDATE bank_transactions SET occurred_at = ${occurredAt}, kind = ${kind}, account_type = ${accountType}, amount = ${amount},
      category = ${category}, reference = ${reference}, notes = ${notes}, updated_at = now()
    WHERE id = ${current.id} AND deleted_at IS NULL
    RETURNING *
  `;
  let transaction = rowToTransaction(rows[0]);
  // A transfer's withdrawal leg never gets an auto-created expense — the
  // money moved from the till to the bank, it wasn't spent.
  if (!current.transfer_id) {
    const expenseId = await syncWithdrawalExpense(transaction, current.expense_id || null);
    if (expenseId !== (current.expense_id || null)) {
      const [linked] = await sql`
        UPDATE bank_transactions SET expense_id = ${expenseId}, updated_at = now()
        WHERE id = ${transaction.id} RETURNING *
      `;
      transaction = rowToTransaction(linked);
    } else if (!expenseId && current.expense_id) {
      const [unlinked] = await sql`
        UPDATE bank_transactions SET expense_id = NULL, updated_at = now()
        WHERE id = ${transaction.id} RETURNING *
      `;
      transaction = rowToTransaction(unlinked);
    }
  } else if (cascade && (input.amount != null || input.occurredAt != null)) {
    // Keep both legs of the transfer in step — the amount and date describe
    // one real-world event, so editing one side must move the other with it.
    const [pair] = await sql`
      SELECT id FROM bank_transactions
      WHERE transfer_id = ${current.transfer_id} AND id != ${current.id} AND deleted_at IS NULL
    `;
    if (pair) {
      await updateBankTransaction(
        { id: pair.id, amount: input.amount != null ? amount : undefined, occurredAt: input.occurredAt != null ? occurredAt : undefined },
        { cascade: false }
      );
    }
  }
  return transaction;
}

export async function deleteBankTransaction(input = {}) {
  const current = await requireTransaction(input.id);
  if (current.expense_id) await deleteExpense({ id: current.expense_id });
  await sql`UPDATE bank_transactions SET deleted_at = now(), updated_at = now() WHERE id = ${current.id}`;
  // Deleting one leg of a cash-to-bank transfer without the other would
  // leave the remaining side representing money that never actually moved.
  if (current.transfer_id) {
    const [pair] = await sql`
      SELECT id, expense_id FROM bank_transactions
      WHERE transfer_id = ${current.transfer_id} AND id != ${current.id} AND deleted_at IS NULL
    `;
    if (pair) {
      if (pair.expense_id) await deleteExpense({ id: pair.expense_id });
      await sql`UPDATE bank_transactions SET deleted_at = now(), updated_at = now() WHERE id = ${pair.id}`;
    }
  }
  return current.id;
}
