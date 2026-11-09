// "No Fix - Client to Collect" and "No Fix - Client Collected": both are
// accepted, and collecting a no-fix device with its diagnostic fee paid
// records the payment (and deposits it) like a pickup does.
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
const { TICKET_STATUSES } = await import("../lib/tickets.js");
const { FINAL_TICKET_STATUSES } = await import("../lib/invoice-merge.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}

await test("both no-fix statuses are valid, and the old plain No Fix still is", async () => {
  for (const s of ["No Fix - Client to Collect", "No Fix - Client Collected", "No Fix"]) assert.ok(TICKET_STATUSES.includes(s), s);
});

await test("only a collected no fix is final for invoices", async () => {
  assert.ok(FINAL_TICKET_STATUSES.includes("No Fix - Client Collected"));
  assert.ok(!FINAL_TICKET_STATUSES.includes("No Fix - Client to Collect"));
});

await test("no fix → client to collect → collected with the diagnostic fee paid in cash", async () => {
  const { ticket } = await api({ action: "add", customerName: "Anita Singh", phone: "8687123456", device: "iPhone 13", issues: "Diagnostic Needed", repairCost: "150", amountPaid: "0" });
  const { ticket: waiting } = await api({ action: "update", id: ticket.id, status: "No Fix - Client to Collect" });
  assert.equal(waiting.status, "No Fix - Client to Collect");
  const { ticket: done, accountDeposit } = await api({ action: "update", id: ticket.id, status: "No Fix - Client Collected", amountPaid: "150", paymentMethod: "cash", depositToAccount: true });
  assert.equal(done.status, "No Fix - Client Collected");
  assert.equal(Number(done.amountPaid), 150);
  assert.equal(done.paymentMethod, "cash");
  assert.equal(accountDeposit.ok, true);
  assert.equal(Number(accountDeposit.deposit.amount), 150);
  assert.match(done.history, /No Fix - Client to Collect → No Fix - Client Collected/);
});

console.log(`All ${passed} no-fix status tests passed`);
