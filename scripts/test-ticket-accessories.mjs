// What the client left with the device (charger, case, bag…) is saved with
// the repair at check-in, can be changed later, and shows in its history.
// Runs the real api/intake.js handler against an in-memory Postgres.
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
const { accessoriesFrom } = await import("../lib/tickets.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const checkIn = (extra) => api({ action: "add", customerName: "Anita Singh", phone: "8687123456", device: "iPhone 13", issues: "Battery Issue", repairCost: "500", ...extra });

await test("accessories are saved with the repair at check-in", async () => {
  const { ticket } = await checkIn({ accessories: "Charger,  Case , Other: blue pouch" });
  assert.equal(ticket.accessories, "Charger, Case, Other: blue pouch");
});

await test("\"None\" records that the client left nothing", async () => {
  const { ticket } = await checkIn({ accessories: "None" });
  assert.equal(ticket.accessories, "None");
});

await test("a check-in without the question (e.g. a quick log) is left unrecorded", async () => {
  const { ticket } = await checkIn({});
  assert.equal(ticket.accessories, "");
});

await test("accessories can be changed later and the change is in the history", async () => {
  const { ticket } = await checkIn({ accessories: "Charger" });
  const { ticket: updated } = await api({ action: "update", id: ticket.id, accessories: "Charger, Bag" });
  assert.equal(updated.accessories, "Charger, Bag");
  assert.match(updated.history, /Left with device: Charger, Bag/);
  // The rest of the repair is untouched by an accessories-only update.
  assert.equal(updated.device, "iPhone 13");
  assert.equal(updated.issues, "Battery Issue");
  assert.equal(Number(updated.repairCost), 500);
});

await test("an update that doesn't mention accessories keeps them", async () => {
  const { ticket } = await checkIn({ accessories: "Case" });
  const { ticket: updated } = await api({ action: "update", id: ticket.id, status: "In Progress" });
  assert.equal(updated.accessories, "Case");
  assert.doesNotMatch(updated.history, /Left with device/);
});

await test("descriptions are kept with each item", async () => {
  const { ticket } = await checkIn({ accessories: "Charger (White Apple USB-C), Case (Clear case), Other: blue pouch" });
  assert.equal(ticket.accessories, "Charger (White Apple USB-C), Case (Clear case), Other: blue pouch");
});

await test("a description can have commas in it", async () => {
  const { ticket } = await checkIn({ accessories: "Charger (White, small scratch on plug, drawer 2), Case" });
  assert.equal(ticket.accessories, "Charger (White, small scratch on plug, drawer 2), Case");
});

await test("the saved text is tidied and capped", async () => {
  assert.equal(accessoriesFrom(" Charger ,, SIM   card "), "Charger, SIM card");
  assert.equal(accessoriesFrom(null), "");
  assert.equal(accessoriesFrom("x".repeat(800)).length, 500);
});

console.log(`All ${passed} accessories tests passed`);
