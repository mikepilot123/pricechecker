// The cheap "has anything changed?" fingerprint the app checks before
// downloading the repairs list: changes on every add/edit/delete/restore,
// stays put otherwise, and only reads (it works on a read-only preview).
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

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body, method = "POST") {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(v) { payload = v; return this; } };
  const req = method === "GET"
    ? { method, headers: {}, query: { pin: "0000", ...body } }
    : { method, headers: {}, body: JSON.stringify({ pin: "0000", ...body }) };
  await intake(req, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const version = async () => (await api({ action: "ticketsVersion" }, "GET")).version;

let id;
await test("the list comes with the same fingerprint the quick check returns", async () => {
  ({ ticket: { id } } = await api({ action: "add", customerName: "Ver (fake)", phone: "8680000990", device: "iPhone 11", issues: "Battery", repairCost: "300" }));
  const list = await api({ action: "list" }, "GET");
  assert.ok(list.version);
  assert.equal(await version(), list.version);
});

await test("unchanged when nothing changed", async () => {
  assert.equal(await version(), await version());
});

await test("changes on add, edit, status change, payment, delete and restore", async () => {
  let v = await version();
  const changed = async (label, fn) => {
    await fn();
    const next = await version();
    assert.notEqual(next, v, label);
    v = next;
  };
  await changed("add", () => api({ action: "add", customerName: "Ver2 (fake)", phone: "8680000991", device: "Pixel 7", issues: "Screen", repairCost: "500" }));
  await changed("edit", () => api({ action: "update", id, notes: "edited" }));
  await changed("status", () => api({ action: "update", id, status: "Diagnosing" }));
  await changed("payment", () => api({ action: "update", id, amountPaid: "100", paymentMethod: "cash", depositToAccount: true }));
  await changed("delete", () => api({ action: "delete", id }));
  await changed("restore", () => db.query("UPDATE tickets SET deleted_at = NULL, updated_at = now() WHERE id = $1", [id]));
});

await test("the check only reads — it works on a read-only preview", async () => {
  process.env.VERCEL_ENV = "preview";
  try {
    assert.ok(await version());
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

console.log(`All ${passed} tickets-version tests passed`);
