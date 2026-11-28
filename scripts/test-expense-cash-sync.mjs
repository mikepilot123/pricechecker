// Every expense comes out of Cash on hand: adding, editing or deleting an
// expense adds, changes or removes its Cash withdrawal on the Bank account
// page (lib/expenses.js, CASHEXP_…). Withdrawals entered on the Bank account
// page already make their own expense, and must not be counted twice.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "1234";
delete process.env.VERCEL_ENV;
delete process.env.OWNER_PIN;
const { db } = await import("./testing/neon-pglite.mjs");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
const { ensureSchema } = await import("../lib/db.js");
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addBankTransaction, updateBankTransaction, deleteBankTransaction, listBankTransactions, bankAccountSummary } = await import("../lib/bank-transactions.js");
const { addExpense, updateExpense, deleteExpense, listExpenses, expenseCashSyncStatus, syncExpensesToCash } = await import("../lib/expenses.js");
const { default: intake } = await import("../api/intake.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
const cashRow = async (expenseId) => (await listBankTransactions()).find((t) => t.id === "CASHEXP_" + expenseId);
const cashBalance = async () => (await bankAccountSummary()).cash.balance;
async function call(body) {
  let payload; let status = 200;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(v) { payload = v; return this; } };
  await intake({ method: "POST", headers: { "user-agent": "test" }, body: JSON.stringify({ pin: "1234", ...body }) }, res);
  return { status, payload };
}

await addBankTransaction({ kind: "deposit", accountType: "cash", amount: 1000, category: "Float" });

let e;
await test("a new expense comes out of Cash on hand", async () => {
  e = await addExpense({ date: "2026-11-27", category: "Parts", vendor: "Ainsley", amount: "300", notes: "Screen for repair #T1" });
  const row = await cashRow(e.id);
  assert.deepEqual([row.kind, row.accountType, row.amount], ["withdrawal", "cash", 300]);
  assert.equal(row.category, "Parts — Ainsley");
  assert.equal(row.reference, "Expense");
  assert.equal(row.occurredAt.slice(0, 10), "2026-11-27");
  assert.equal(await cashBalance(), 700);
});

await test("editing the expense moves the cash withdrawal with it", async () => {
  await updateExpense({ id: e.id, amount: "250", date: "2026-11-26", vendor: "Mobile Sentrix" });
  const row = await cashRow(e.id);
  assert.equal(row.amount, 250);
  assert.equal(row.occurredAt.slice(0, 10), "2026-11-26");
  assert.equal(row.category, "Parts — Mobile Sentrix");
  assert.equal(await cashBalance(), 750);
});

await test("deleting the expense puts the cash back", async () => {
  await deleteExpense({ id: e.id });
  assert.equal(await cashRow(e.id), undefined);
  assert.equal(await cashBalance(), 1000);
});

await test("a withdrawal entered on the Bank account page isn't counted twice", async () => {
  const w = await addBankTransaction({ kind: "withdrawal", accountType: "cash", amount: 100, category: "Cleaning" });
  const expenses = await listExpenses();
  assert.ok(expenses.some((x) => x.id === w.expenseId), "it still makes its expense");
  assert.equal(await cashRow(w.expenseId), undefined, "no second cash row");
  assert.equal(await cashBalance(), 900);
  await deleteBankTransaction({ id: w.id });
  assert.equal(await cashBalance(), 1000);
});

await test("an expense's cash withdrawal can't be changed from the Bank account page", async () => {
  const x = await addExpense({ date: "2026-11-27", category: "Tools", amount: "40" });
  await assert.rejects(updateBankTransaction({ id: "CASHEXP_" + x.id, amount: 10 }), /comes from an expense/);
  await assert.rejects(deleteBankTransaction({ id: "CASHEXP_" + x.id }), /comes from an expense/);
  assert.equal((await cashRow(x.id)).amount, 40);
  assert.equal((await listExpenses()).filter((y) => y.amount === 40).length, 1, "no extra expense made");
  await deleteExpense({ id: x.id });
});

await test("older expenses are brought in only by Sync now, once", async () => {
  // Recorded before this existed: no cash row.
  await db.query("INSERT INTO expenses (id, date, category, vendor, amount) VALUES ('OLD1', '2026-11-01', 'Rent', 'Landlord', 500), ('OLD2', '2026-11-03', 'Parts', '', 75.5)");
  // A cash row left behind by an expense that's gone.
  await db.query("INSERT INTO bank_transactions (id, kind, amount, account_type) VALUES ('CASHEXP_GONE', 'withdrawal', 20, 'cash')");
  assert.deepEqual(await expenseCashSyncStatus(), { missing: 2, total: 575.5, orphans: 1 });
  assert.equal(await cashBalance(), 980, "nothing changes until Sync now");
  const result = await syncExpensesToCash();
  assert.deepEqual(result, { synced: 2, removed: 1, total: 575.5 });
  assert.equal((await cashRow("OLD1")).amount, 500);
  assert.equal(await cashBalance(), 1000 - 575.5);
  assert.deepEqual(await expenseCashSyncStatus(), { missing: 0, total: 0, orphans: 0 });
  assert.deepEqual(await syncExpensesToCash(), { synced: 0, removed: 0, total: 0 }, "running it again changes nothing");
});

await test("API: status and Sync now", async () => {
  await db.query("INSERT INTO expenses (id, date, category, amount) VALUES ('OLD3', '2026-11-05', 'Other', 10)");
  const status = await call({ action: "getExpenseCashSync" });
  assert.equal(status.payload.ok, true, status.payload.error);
  assert.equal(status.payload.missing, 1);
  const synced = await call({ action: "syncExpensesToCash" });
  assert.equal(synced.payload.synced, 1);
  assert.equal((await call({ action: "getExpenseCashSync" })).payload.missing, 0);
});

console.log(`PASS — ${passed} expense cash sync scenarios`);
