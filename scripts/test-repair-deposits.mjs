// Repair payments confirmed as cash or bank transfer land on the Account tab
// by themselves — cash to cash on hand, a transfer to the bank balance.
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
const { listBankTransactions, bankAccountSummary } = await import("../lib/bank-transactions.js");
const { default: handler } = await import("../api/intake.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const checkIn = (extra) => api({ action: "add", customerName: "Anita Singh", phone: "8687123456", device: "iPhone 13", issues: "Screen Cracked / Broken", repairCost: "800", ...extra });

await test("a cash payment at check-in goes to cash on hand", async () => {
  const { ticket, accountDeposit } = await checkIn({ amountPaid: "300", paymentMethod: "cash", depositToAccount: true });
  assert.equal(ticket.paymentMethod, "cash", "the repair records how it was paid");
  assert.equal(accountDeposit.ok, true);
  assert.deepEqual(
    [accountDeposit.deposit.kind, accountDeposit.deposit.accountType, accountDeposit.deposit.amount],
    ["deposit", "cash", 300],
  );
  assert.equal(accountDeposit.deposit.category, "Anita Singh — Cash payment", "titled with the client and how they paid");
  assert.equal(accountDeposit.deposit.reference, `Repair #${ticket.id}`);
  assert.equal(accountDeposit.deposit.notes, "iPhone 13 Screen Replacement", "the repair done, named as on the invoice, goes in the notes");
  const summary = await bankAccountSummary();
  assert.deepEqual([summary.cash.balance, summary.balance], [300, 0]);
});

await test("picking up with a bank transfer deposits only the balance, to the bank", async () => {
  const { ticket } = await checkIn({ amountPaid: "200", paymentMethod: "cash", depositToAccount: true });
  const { accountDeposit } = await api({ action: "update", id: ticket.id, status: "Picked Up", amountPaid: "800", paymentMethod: "transfer", depositToAccount: true });
  assert.deepEqual([accountDeposit.deposit.accountType, accountDeposit.deposit.amount], ["bank", 600]);
  assert.equal(accountDeposit.deposit.category, "Anita Singh — Bank transfer");
  const summary = await bankAccountSummary();
  assert.deepEqual([summary.cash.balance, summary.balance], [500, 600]);
});

await test("nothing is deposited without the flag, a method, or new money", async () => {
  const before = (await listBankTransactions()).length;
  const plain = await checkIn({ amountPaid: "100" });
  assert.equal(plain.accountDeposit, null, "older clients that don't ask get no deposit");
  const noMethod = await checkIn({ amountPaid: "100", depositToAccount: true });
  assert.equal(noMethod.accountDeposit, null, "no cash/transfer method means nothing to deposit");
  const unpaid = await checkIn({ amountPaid: "", paymentMethod: "cash", depositToAccount: true });
  assert.equal(unpaid.accountDeposit, null, "nothing paid, nothing deposited");
  const resaved = await api({ action: "update", id: plain.ticket.id, notes: "Re-saved", amountPaid: "100", paymentMethod: "cash", depositToAccount: true });
  assert.equal(resaved.accountDeposit, null, "re-saving the same amount never deposits it twice");
  const lowered = await api({ action: "update", id: plain.ticket.id, amountPaid: "50", paymentMethod: "cash", depositToAccount: true });
  assert.equal(lowered.accountDeposit, null, "a lower amount paid is a correction, not a deposit");
  assert.equal((await listBankTransactions()).length, before);
});

await test("recording a balance payment from Device details deposits each part as it's paid", async () => {
  // What the Record payment button sends: only the new Amount paid, how it
  // was paid, and the deposit flag — the status and everything else stay put.
  const { ticket } = await checkIn({ amountPaid: "400", paymentMethod: "cash", depositToAccount: true, status: "In Progress" });
  const before = await bankAccountSummary();
  const part = await api({ action: "update", id: ticket.id, amountPaid: 650, paymentMethod: "transfer", cardType: "", depositToAccount: true });
  assert.deepEqual([part.accountDeposit.deposit.accountType, part.accountDeposit.deposit.amount], ["bank", 250]);
  assert.deepEqual([Number(part.ticket.amountPaid), part.ticket.paymentMethod, part.ticket.status], [650, "transfer", "In Progress"]);
  const rest = await api({ action: "update", id: ticket.id, amountPaid: 800, paymentMethod: "cash", cardType: "", depositToAccount: true });
  assert.deepEqual([rest.accountDeposit.deposit.accountType, rest.accountDeposit.deposit.amount], ["cash", 150]);
  assert.equal(Number(rest.ticket.amountPaid), 800, "paid in full");
  const after = await bankAccountSummary();
  assert.deepEqual([after.balance - before.balance, after.cash.balance - before.cash.balance], [250, 150]);
});

console.log(`PASS — ${passed} repair deposit scenarios`);
await db.close();
