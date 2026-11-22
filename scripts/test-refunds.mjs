// Refunds on a repair: a fake client pays up front for a screen, the
// diagnosis finds a board fault, they don't go ahead and get money back.
// Checks the repair, its activity log, the Account tab and the invoice.
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
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: handler } = await import("../api/intake.js");
const { listExpenses } = await import("../lib/expenses.js");
const { bankAccountSummary } = await import("../lib/bank-transactions.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function call(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  return payload;
}
async function api(body) {
  const payload = await call(body);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
async function cashOnHand() {
  const { transactions } = await api({ action: "listBankTransactions" });
  return transactions.filter((t) => t.accountType === "cash").reduce((s, t) => s + t.signedAmount, 0);
}

// The fake repair: TT$650 screen, TT$300 paid in cash at check-in.
const { ticket: fake } = await api({
  action: "add", customerName: "Test Client (fake)", phone: "8680000000", device: "iPhone 12",
  issues: "Screen Cracked / Broken", repairCost: "650", amountPaid: "300", paymentMethod: "cash", depositToAccount: true,
});

await test("the fake repair's TT$300 cash deposit is on the Account tab", async () => {
  assert.equal(Number(fake.amountPaid), 300);
  assert.equal(await cashOnHand(), 300);
});

await test("a refund needs a reason, a method, and no more than was paid", async () => {
  for (const [bad, msg] of [
    [{ amount: "250", method: "cash", reason: "" }, /reason/],
    [{ amount: "250", method: "card", reason: "x" }, /cash or bank transfer/],
    [{ amount: "300.01", method: "cash", reason: "x" }, /more than/],
    [{ amount: "0", method: "cash", reason: "x" }, /greater than zero/],
  ]) {
    const res = await call({ action: "refund", id: fake.id, ...bad });
    assert.equal(res.ok, false);
    assert.match(res.error, msg);
  }
  const { tickets } = await api({ action: "list" });
  assert.equal(Number(tickets.find((t) => t.id === fake.id).amountPaid), 300, "a rejected refund changes nothing");
  assert.equal(await cashOnHand(), 300);
});

await test("diagnosis finds a board fault — refund TT$250 cash, keep TT$50 diagnostic, cancel", async () => {
  const res = await api({
    action: "refund", id: fake.id, amount: "250", method: "cash",
    reason: "Logged for a screen; diagnosis found a board fault, client chose not to go ahead",
    closeAs: "Cancelled",
  });
  const t = res.ticket;
  assert.equal(t.status, "Cancelled");
  assert.equal(Number(t.amountPaid), 50);
  assert.equal(Number(t.repairCost), 50, "charge becomes what the client keeps");
  assert.equal(t.refunded, 250);
  assert.match(t.history, /Refunded TT\$250\.00 by cash — Logged for a screen, diagnosis found a board fault/);
  assert.match(t.history, /Status: Received → Cancelled/);
  assert.equal(res.accountWithdrawal.ok, true);
  assert.equal(res.accountWithdrawal.withdrawal.kind, "withdrawal");
  assert.equal(res.accountWithdrawal.withdrawal.accountType, "cash");
  assert.equal(res.accountWithdrawal.withdrawal.reference, `Repair #${fake.id}`);
});

await test("cash on hand drops by the refund, and it isn't logged as an expense", async () => {
  assert.equal(await cashOnHand(), 50);
  const expenses = await listExpenses();
  assert.equal(expenses.length, 0, JSON.stringify(expenses));
});

await test("a second refund (the TT$50 diagnostic fee too) by bank transfer", async () => {
  const { ticket: t2 } = await api({ action: "add", customerName: "Test Client 2 (fake)", phone: "8680000001", device: "Galaxy A52", issues: "Battery", repairCost: "400", amountPaid: "400", paymentMethod: "transfer", depositToAccount: true });
  const res = await api({ action: "refund", id: t2.id, amount: "400", method: "transfer", reason: "Client changed their mind" });
  assert.equal(Number(res.ticket.amountPaid), 0);
  assert.equal(res.ticket.status, "Received", "status kept when not closing");
  assert.equal(Number(res.ticket.repairCost), 400, "charge kept when not closing");
  assert.equal(res.accountWithdrawal.withdrawal.accountType, "bank");
  const again = await call({ action: "refund", id: t2.id, amount: "1", method: "cash", reason: "x" });
  assert.equal(again.ok, false, "nothing left to refund");
});

await test("a refund after pickup lowers the charge and the month's sales", async () => {
  const { ticket: t3 } = await api({ action: "add", customerName: "Test Client 3 (fake)", phone: "8680000002", device: "iPad 9", issues: "Charging port", repairCost: "500", amountPaid: "500", paymentMethod: "cash", depositToAccount: true });
  await api({ action: "update", id: t3.id, status: "Picked Up" });
  const before = (await api({ action: "listMonthlySales" })).months[0];
  assert.equal(Number(before.totalSales), 500);
  const res = await api({ action: "refund", id: t3.id, amount: "100", method: "cash", reason: "Goodwill — port loose again" });
  assert.equal(res.ticket.status, "Picked Up");
  assert.equal(Number(res.ticket.repairCost), 400);
  assert.equal(Number(res.ticket.amountPaid), 400);
  const after = (await api({ action: "listMonthlySales" })).months[0];
  assert.equal(Number(after.totalSales), 400);
});

await test("an update request can't smuggle in a fake refund", async () => {
  const res = await api({ action: "update", id: fake.id, _refund: { amount: 999, summary: "Refunded TT$999.00 by cash — fake" } });
  assert.equal(res.ticket.refunded, 250);
  assert.doesNotMatch(res.ticket.history, /TT\$999/);
});

console.log(`All ${passed} refund tests passed`);
