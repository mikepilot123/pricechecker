// Logging a repair can't create duplicates: a retry with the same request id
// gets the repair already saved (and its payment isn't deposited twice), two
// racing copies of one attempt make one repair, and repair numbers are a
// primary key — a clash fails instead of overwriting.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
delete process.env.VERCEL_ENV;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: intake } = await import("../api/intake.js");
const { addTicket } = await import("../lib/tickets.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(v) { payload = v; return this; } };
  await intake({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  return payload;
}
const count = async (sqlText, params = []) => Number((await db.query(sqlText, params)).rows[0].n);
const repair = (extra = {}) => ({ action: "add", customerName: "Dup (fake)", phone: "8680000950", device: "iPhone 13", issues: "Battery", repairCost: "300", amountPaid: "300", paymentMethod: "cash", depositToAccount: true, ...extra });

await test("a retry with the same request id returns the repair already saved", async () => {
  const first = await api(repair({ clientRequestId: "Rtest-retry-1" }));
  assert.equal(first.ok, true, first.error);
  assert.equal(first.accountDeposit.ok, true);
  const retry = await api(repair({ clientRequestId: "Rtest-retry-1" }));
  assert.equal(retry.ok, true);
  assert.equal(retry.ticket.id, first.ticket.id, "same repair");
  assert.equal(retry.alreadySaved, true);
  assert.equal(retry.accountDeposit, null, "no second deposit");
  assert.equal(await count("SELECT count(*) AS n FROM tickets WHERE client_request_id = 'Rtest-retry-1'"), 1);
  assert.equal(await count("SELECT count(*) AS n FROM bank_transactions WHERE reference = $1", [`Repair #${first.ticket.id}`]), 1, "cash deposited once");
});

await test("two copies of the same attempt racing make one repair", async () => {
  const [a, b] = await Promise.all([api(repair({ clientRequestId: "Rtest-race-1" })), api(repair({ clientRequestId: "Rtest-race-1" }))]);
  assert.equal(a.ok && b.ok, true, a.error || b.error);
  assert.equal(a.ticket.id, b.ticket.id);
  assert.equal(await count("SELECT count(*) AS n FROM tickets WHERE client_request_id = 'Rtest-race-1'"), 1);
});

await test("different attempts (or no request id, as before) make separate repairs", async () => {
  const before = await count("SELECT count(*) AS n FROM tickets");
  await api(repair({ clientRequestId: "Rtest-a" }));
  await api(repair({ clientRequestId: "Rtest-b" }));
  await api(repair());
  await api(repair());
  assert.equal(await count("SELECT count(*) AS n FROM tickets"), before + 4);
});

await test("repair numbers are a primary key: a clash fails, it never overwrites", async () => {
  const realNow = Date.now; const realRandom = Math.random;
  Date.now = () => 1800000000000; Math.random = () => 0.5;
  try {
    const first = await addTicket({ customerName: "Original (fake)", phone: "8680000951", device: "Pixel 8", issues: "Battery" });
    await assert.rejects(addTicket({ customerName: "Clash (fake)", phone: "8680000952", device: "iPad", issues: "Screen" }), /duplicate key|unique/i);
    const row = (await db.query("SELECT customer_name FROM tickets WHERE id = $1", [first.id])).rows[0];
    assert.equal(row.customer_name, "Original (fake)");
  } finally {
    Date.now = realNow; Math.random = realRandom;
  }
});

console.log(`All ${passed} duplicate-safety tests passed`);
