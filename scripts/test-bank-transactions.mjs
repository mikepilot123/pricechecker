import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
const { db } = await import("./testing/neon-pglite.mjs");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
const { ensureSchema } = await import("../lib/db.js");
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addBankTransaction, updateBankTransaction, deleteBankTransaction, listBankTransactions, bankAccountSummary, addCashDepositToBank } = await import("../lib/bank-transactions.js");
const { listExpenses } = await import("../lib/expenses.js");

const deposit = await addBankTransaction({ kind: "deposit", amount: 1500, occurredAt: new Date().toISOString(), category: "Opening balance", reference: "OPEN" });
const withdrawal = await addBankTransaction({ kind: "withdrawal", amount: 225.5, occurredAt: new Date().toISOString(), category: "Inventory" });
assert.equal(deposit.accountType, "bank", "omitting accountType defaults to bank");
assert.equal((await bankAccountSummary()).balance, 1274.5);
assert.equal((await listBankTransactions()).length, 2);
let expenses = await listExpenses();
assert.equal(expenses.length, 1);
assert.equal(expenses[0].vendor, "Inventory");
assert.equal(expenses[0].amount, 225.5);
assert.equal(expenses[0].category, "Bank withdrawal");

// Cash on hand is the same ledger, a separate running balance — a cash
// transaction must never move the bank figures above, and vice versa.
const cashDeposit = await addBankTransaction({ kind: "deposit", accountType: "cash", amount: 500, occurredAt: new Date().toISOString(), category: "Till float" });
const cashWithdrawal = await addBankTransaction({ kind: "withdrawal", accountType: "cash", amount: 80, occurredAt: new Date().toISOString(), category: "Petty cash" });
assert.equal(cashDeposit.accountType, "cash");
let summary = await bankAccountSummary();
assert.equal(summary.balance, 1274.5, "bank balance is untouched by cash activity");
assert.equal(summary.cash.balance, 420, "cash balance reflects only cash transactions");
assert.equal((await listBankTransactions()).length, 4);
expenses = await listExpenses();
const cashExpense = expenses.find((e) => e.id === cashWithdrawal.expenseId);
assert.equal(cashExpense.category, "Cash withdrawal", "a cash withdrawal is labeled distinctly from a bank one");

await assert.rejects(addBankTransaction({ kind: "deposit", accountType: "wallet", amount: 10 }), /bank or cash/);

// Moving an existing transaction between ledgers must move its balance too.
const movedToCash = await updateBankTransaction({ id: deposit.id, accountType: "cash" });
assert.equal(movedToCash.accountType, "cash");
summary = await bankAccountSummary();
assert.equal(summary.balance, -225.5, "the bank ledger loses that deposit");
assert.equal(summary.cash.balance, 1920, "the cash ledger gains it");
const movedBack = await updateBankTransaction({ id: deposit.id, accountType: "bank" });
assert.equal(movedBack.accountType, "bank");
assert.equal((await bankAccountSummary()).balance, 1274.5, "moving it back restores the bank balance");

const edited = await updateBankTransaction({ id: withdrawal.id, amount: 200, notes: "Corrected" });
assert.equal(edited.notes, "Corrected");
assert.equal((await bankAccountSummary()).balance, 1300);
expenses = await listExpenses();
const editedExpense = expenses.find((e) => e.id === edited.expenseId);
assert.equal(editedExpense.amount, 200);
assert.equal(editedExpense.notes, "Corrected");

await assert.rejects(addBankTransaction({ kind: "transfer", amount: 10 }), /deposit or withdrawal/);
await assert.rejects(addBankTransaction({ kind: "deposit", amount: 0 }), /greater than zero/);
await deleteBankTransaction({ id: deposit.id });
assert.equal((await bankAccountSummary()).balance, -200);
assert.equal((await bankAccountSummary()).cash.balance, 420, "deleting a bank row leaves cash untouched");
assert.equal((await listBankTransactions()).length, 3, "the bank deposit is gone; both cash rows remain");

// Depositing cash into the bank moves money between ledgers, not just into one.
const before = await bankAccountSummary();
const transfer = await addCashDepositToBank({ amount: 150, occurredAt: new Date().toISOString(), notes: "Till count" });
assert.equal(transfer.withdrawal.accountType, "cash");
assert.equal(transfer.deposit.accountType, "bank");
assert.equal(transfer.withdrawal.transferId, transfer.deposit.transferId, "both legs share a transfer id");
let after = await bankAccountSummary();
assert.equal(after.balance, before.balance + 150, "the bank side gains the deposit");
assert.equal(after.cash.balance, before.cash.balance - 150, "the cash side loses the same amount");
let expensesAfterTransfer = await listExpenses();
assert.ok(!expensesAfterTransfer.some((e) => e.id === transfer.withdrawal.expenseId), "a transfer's cash leg is not a real expense");

// Editing either leg's amount keeps the pair in step.
const editedTransfer = await updateBankTransaction({ id: transfer.deposit.id, amount: 200 });
assert.equal(editedTransfer.amount, 200);
after = await bankAccountSummary();
assert.equal(after.balance, before.balance + 200, "the bank leg picked up the new amount");
assert.equal(after.cash.balance, before.cash.balance - 200, "the cash leg followed it");

// Deleting one leg removes both, so the ledger never records money that only half-moved.
await deleteBankTransaction({ id: editedTransfer.id });
after = await bankAccountSummary();
assert.equal(after.balance, before.balance, "deleting the bank leg undoes the whole transfer");
assert.equal(after.cash.balance, before.cash.balance, "and restores the cash side too");
assert.ok(!(await listBankTransactions()).some((t) => t.transferId === transfer.withdrawal.transferId), "both transfer rows are gone");

console.log("PASS — bank transaction ledger scenarios");
await db.close();
