// "Drop by Ainsley" split into "To Be Dropped by Ainsley" and "Being Repaired
// by Ainsley"; repairs still on the old status move to "Being Repaired".
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
const { ensureSchema, sql } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: handler } = await import("../api/intake.js");
const { TICKET_STATUSES } = await import("../lib/tickets.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}

await test("both Ainsley statuses are offered, the old one isn't", async () => {
  assert.ok(TICKET_STATUSES.includes("To Be Dropped by Ainsley"));
  assert.ok(TICKET_STATUSES.includes("Being Repaired by Ainsley"));
  assert.ok(!TICKET_STATUSES.includes("Drop by Ainsley"));
});

await test("a repair moves To Be Dropped → Being Repaired by Ainsley", async () => {
  const { ticket } = await api({ action: "add", customerName: "Ainsley Fake (test)", phone: "8680000601", device: "MacBook Air", issues: "Motherboard", repairCost: "1500" });
  const { ticket: out } = await api({ action: "update", id: ticket.id, status: "To Be Dropped by Ainsley" });
  assert.equal(out.status, "To Be Dropped by Ainsley");
  const { ticket: there } = await api({ action: "update", id: ticket.id, status: "Being Repaired by Ainsley" });
  assert.equal(there.status, "Being Repaired by Ainsley");
  assert.match(there.history, /To Be Dropped by Ainsley → Being Repaired by Ainsley/);
});

await test("repairs still on the old 'Drop by Ainsley' move to 'Being Repaired by Ainsley'", async () => {
  const { ticket } = await api({ action: "add", customerName: "Old Status Fake (test)", phone: "8680000602", device: "iPad Pro", issues: "Charging port", repairCost: "600" });
  await sql`UPDATE tickets SET status = 'Drop by Ainsley' WHERE id = ${ticket.id}`;
  await db.exec(readFileSync(new URL("053_split_ainsley_status.sql", migrations), "utf8"));
  const { tickets } = await api({ action: "list" });
  assert.equal(tickets.find((t) => t.id === ticket.id).status, "Being Repaired by Ainsley");
});

console.log(`All ${passed} Ainsley status tests passed`);
