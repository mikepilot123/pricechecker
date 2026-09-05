// Real Postgres integration checks for partial expense collections.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
const { db } = await import("./testing/neon-pglite.mjs");
const { sql, ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addExpense, updateExpense, listExpenses, addExpenseCollection, undoExpenseCollection, deleteExpense } = await import("../lib/expenses.js");
const { updateReminder, listReminders } = await import("../lib/reminders.js");
const { accountSummary } = await import("../lib/card-payments.js");
const { default: handler } = await import("../api/intake.js");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
const expense = await addExpense({ id: "expense-test", date: "2026-09-05", amount: 1000, category: "Parts", vendor: "Test vendor", cashReclaim: true, reclaimFrom: "Test business", reclaimDueAt: "2026-09-12T13:00:00Z" });
const collect = (collectionId, amount, extra = {}) => addExpenseCollection({ id: expense.id, collectionId, amount, ...extra });
const current = async () => (await listExpenses()).find((e) => e.id === expense.id);
const reminder = async () => (await listReminders()).find((r) => r.expenseId === expense.id);
await test("first partial payment reduces debt, preserving the original expense", async () => {
  const e = await collect("first", 250.25, { notes: "Cash" });
  assert.deepEqual([e.amount, e.collectedAmount, e.remainingAmount, e.reclaimedAt], [1000, 250.25, 749.75, null]);
  assert.equal(e.collections.length, 1);
  assert.equal(e.collections[0].notes, "Cash");
  assert.equal((await reminder()).amount, 749.75);
  assert.equal((await reminder()).done, false);
  assert.match((await reminder()).title, /749\.75/);
  assert.equal((await accountSummary()).expenseReclaim.total, 749.75);
});
await test("retrying the same receipt is idempotent", async () => {
  const e = await collect("first", 250.25, { notes: "Cash" });
  assert.equal(e.collectedAmount, 250.25);
  assert.equal(e.collections.length, 1);
  await assert.rejects(collect("first", 300), /different details/);
});
await test("invalid or excessive collections are rejected without changing the balance", async () => {
  for (const amount of [0, -1, "", "abc", "Infinity", "0.001", "10.999", 750, "10000000000"]) {
    await assert.rejects(collect("bad-" + amount, amount));
  }
  assert.equal((await current()).collectedAmount, 250.25);
});
await test("ordinary edits and older clients preserve partial collections", async () => {
  const e = await updateExpense({ id: expense.id, vendor: "Corrected vendor", reclaimed: false });
  assert.equal(e.collectedAmount, 250.25);
  assert.equal(e.collections.length, 1);
  await assert.rejects(updateExpense({ id: expense.id, amount: 200 }), /less than the amount already collected/);
  assert.equal((await current()).amount, 1000);
});
await test("the final collection settles both the expense and reminder", async () => {
  const e = await collect("final", 749.75);
  assert.equal(e.remainingAmount, 0);
  assert.ok(e.reclaimedAt);
  assert.equal((await reminder()).done, true);
  assert.equal((await reminder()).amount, 0);
  assert.equal((await accountSummary()).expenseReclaim.total, 0);
  await assert.rejects(collect("extra", 0.01), /exceeds/);
});
await test("undo restores only that receipt and retains its history", async () => {
  let e = await undoExpenseCollection({ id: expense.id, collectionId: "final" });
  assert.equal(e.collectedAmount, 250.25);
  assert.equal(e.remainingAmount, 749.75);
  assert.ok(e.collections.find((c) => c.id === "final").voidedAt);
  assert.equal((await reminder()).done, false);
  assert.equal((await reminder()).amount, 749.75);
  e = await undoExpenseCollection({ id: expense.id, collectionId: "final" });
  assert.equal(e.collectedAmount, 250.25);
  e = await collect("final", 749.75);
  assert.equal(e.collectedAmount, 250.25); // late network retry cannot resurrect it
});
await test("reminder completion collects the remainder and reopening preserves earlier payments", async () => {
  await updateReminder({ id: "CASHBACK:" + expense.id, done: true });
  assert.equal((await current()).collectedAmount, 1000);
  assert.equal((await reminder()).amount, 0);
  await updateReminder({ id: "CASHBACK:" + expense.id, done: false });
  assert.equal((await current()).collectedAmount, 250.25);
  assert.equal((await reminder()).amount, 749.75);
});
await test("disabling cash reclaim does not erase receipts, and re-enabling restores the debt", async () => {
  await updateExpense({ id: expense.id, cashReclaim: false });
  assert.equal((await current()).collectedAmount, 250.25);
  assert.equal((await accountSummary()).expenseReclaim.total, 0);
  await assert.rejects(collect("not-reclaim", 10), /not marked/);
  await updateExpense({ id: expense.id, cashReclaim: true });
  assert.equal((await reminder()).amount, 749.75);
});
await test("legacy fully collected expenses survive migration and edits", async () => {
  await sql`INSERT INTO expenses (id, date, amount, cash_reclaim, reclaimed_at) VALUES ('legacy', '2026-09-01', 120, TRUE, now())`;
  let e = (await listExpenses()).find((x) => x.id === "legacy");
  assert.deepEqual([e.collectedAmount, e.remainingAmount], [120, 0]);
  assert.equal(e.collections[0].id, "legacy-legacy");
  e = await updateExpense({ id: "legacy", vendor: "Legacy vendor" });
  assert.deepEqual([e.collectedAmount, e.remainingAmount], [120, 0]);
  e = await undoExpenseCollection({ id: "legacy", collectionId: "legacy-legacy" });
  assert.deepEqual([e.collectedAmount, e.remainingAmount], [0, 120]);
  await deleteExpense({ id: "legacy" });
});
await test("old mark-collected controls settle only the outstanding portion", async () => {
  await updateExpense({ id: expense.id, reclaimed: true });
  assert.equal((await current()).collectedAmount, 1000);
  await updateExpense({ id: expense.id, reclaimed: false });
  assert.equal((await current()).collectedAmount, 250.25);
});
await test("raising a settled expense reopens only its additional balance", async () => {
  await updateExpense({ id: expense.id, reclaimed: true });
  const e = await updateExpense({ id: expense.id, amount: 1100 });
  assert.equal(e.remainingAmount, 100);
  assert.equal(e.reclaimedAt, null);
  assert.equal((await reminder()).amount, 100);
});
await test("collection and reminder roll back together on a database error", async () => {
  await db.exec(`CREATE FUNCTION reject_collection_reminder() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test reminder failure'; END $$;
    CREATE TRIGGER reject_collection_reminder BEFORE UPDATE ON reminders FOR EACH ROW EXECUTE FUNCTION reject_collection_reminder();`);
  await assert.rejects(collect("rolled-back", 10), /test reminder failure/);
  await db.exec('DROP TRIGGER reject_collection_reminder ON reminders; DROP FUNCTION reject_collection_reminder();');
  assert.equal((await current()).remainingAmount, 100);
  assert.equal((await current()).collections.some((c) => c.id === "rolled-back"), false);
});
await test("simultaneous collection requests cannot overwrite or over-collect", async () => {
  const results = await Promise.allSettled([collect("concurrent-a", 60), collect("concurrent-b", 60)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await current()).remainingAmount, 40);
  assert.equal((await reminder()).amount, 40);
});
async function api(body) {
  let status, payload;
  const response = { setHeader() {}, status(code) { status = code; return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify(body) }, response);
  return { status, payload };
}
await test("API collection actions require the PIN and return the updated expense", async () => {
  const denied = await api({ action: "addExpenseCollection", id: expense.id, collectionId: "api", amount: 20 });
  // This API deliberately returns 200 for a bad PIN so the response shape is
  // consistent with the older Apps Script client; the body carries the error.
  assert.equal(denied.status, 200);
  assert.equal(denied.payload.ok, false);
  const saved = await api({ pin: "0000", action: "addExpenseCollection", id: expense.id, collectionId: "api", amount: 20 });
  assert.equal(saved.payload.ok, true);
  assert.equal(saved.payload.expense.remainingAmount, 20);
  const undone = await api({ pin: "0000", action: "undoExpenseCollection", id: expense.id, collectionId: "api" });
  assert.equal(undone.payload.expense.remainingAmount, 40);
});
await test("deleted expenses reject further collections and retire their reminder", async () => {
  await deleteExpense({ id: expense.id });
  await assert.rejects(collect("deleted", 10), /not found/);
  assert.equal(await reminder(), undefined);
  assert.equal((await accountSummary()).expenseReclaim.total, 0);
});
console.log(`PASS — ${passed} expense collection scenarios`);
await db.close();
