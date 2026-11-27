// Failed saves leave a lasting record (save_failures), with the PIN and other
// secrets removed; recording never hides the original error; and the list is
// PIN-protected.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "7391";
process.env.PUBLIC_APP_URL = "https://repairs.example";
delete process.env.VERCEL_ENV;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: intake } = await import("../api/intake.js");
const { default: invoiceApi } = await import("../api/invoice.js");
const { scrubForLog, recordSaveFailure } = await import("../lib/save-failures.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function call(handler, body, { method = "POST", pin = "7391" } = {}) {
  let payload; let status = 200;
  const response = { setHeader() {}, status(s) { status = s; return this; }, json(v) { payload = v; return this; }, send() { return this; }, end() { return this; } };
  const req = method === "GET"
    ? { method, headers: {}, query: { pin, ...body } }
    : { method, headers: {}, body: JSON.stringify({ pin, ...body }) };
  await handler(req, response);
  return { status, payload };
}
const failures = async () => (await db.query("SELECT * FROM save_failures ORDER BY id")).rows;

await test("a repair save that throws is recorded, PIN removed, same error returned", async () => {
  const { payload } = await call(intake, { action: "add", customerName: "Fail (fake)", phone: "8680000800", device: "iPhone 12", issues: "Battery", repairCost: "abc" });
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Repair cost must be a valid/);
  const [row] = await failures();
  assert.equal(row.route, "/api/intake");
  assert.equal(row.action, "add");
  assert.equal(row.source, "server");
  assert.match(row.error, /Repair cost must be a valid/);
  assert.equal(row.body.customerName, "Fail (fake)", "what was being saved is kept");
  assert.equal(row.body.pin, "[removed]");
  assert.ok(!JSON.stringify(row.body).includes("7391"), "the PIN never reaches the table");
});

await test("payments/refunds and expenses go through the same route and are recorded too", async () => {
  await call(intake, { action: "refund", id: "NOPE", amount: "50", method: "cash", reason: "x" });
  await call(intake, { action: "addExpense", date: "", amount: "-5" });
  const actions = (await failures()).map((r) => r.action);
  assert.ok(actions.includes("refund"));
  assert.ok(actions.includes("addExpense"));
});

await test("failed reads aren't recorded as failed saves", async () => {
  const before = (await failures()).length;
  await call(intake, { action: "listTicketNotes", ticketId: "" });
  await call(intake, { action: "getNothing" });
  assert.equal((await failures()).length, before);
});

await test("an invoice save that throws is recorded", async () => {
  const { payload } = await call(invoiceApi, { action: "update", id: "NO-SUCH-INVOICE", invoice: { notes: "x" } });
  assert.equal(payload.ok, false);
  const last = (await failures()).at(-1);
  assert.equal(last.route, "/api/invoice");
  assert.equal(last.action, "update");
  assert.equal(last.body.invoice.notes, "x");
});

await test("a device can report a save that never reached the server", async () => {
  const { payload } = await call(intake, {
    action: "reportClientSaveFailure",
    report: { route: "/api/intake", action: "add", error: "No answer from the server (Failed to fetch)", at: "2026-11-27T10:00:00Z", body: { customerName: "Offline (fake)", device: "Pixel 8", pin: "7391" } },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.recorded, true);
  const last = (await failures()).at(-1);
  assert.equal(last.source, "client");
  assert.equal(last.body.customerName, "Offline (fake)");
  assert.equal(last.body.pin, "[removed]");
  assert.match(last.error, /on the device at 2026-11-27T10:00:00Z/);
});

await test("the list needs the PIN and returns newest first", async () => {
  const denied = await call(intake, { action: "listSaveFailures" }, { method: "GET", pin: "9999" });
  assert.notEqual(denied.payload.ok, true);
  const { payload } = await call(intake, { action: "listSaveFailures" }, { method: "GET" });
  assert.equal(payload.ok, true);
  assert.ok(payload.failures.length >= 5);
  assert.equal(payload.failures[0].source, "client", "newest first");
});

await test("secrets and huge values are scrubbed", async () => {
  const s = scrubForLog({ pin: "1", ownerPin: "2", nested: { apiKey: "k", clientSecret: "s", password: "p", accessToken: "t" }, pdfBase64: "A".repeat(50000), name: "ok" });
  assert.equal(s.pin, "[removed]");
  assert.equal(s.ownerPin, "[removed]");
  assert.deepEqual(Object.values(s.nested), ["[removed]", "[removed]", "[removed]", "[removed]"]);
  assert.ok(s.pdfBase64.length < 400);
  assert.equal(s.name, "ok");
});

await test("if recording fails too, it doesn't throw (the original error still goes back)", async () => {
  await db.query("ALTER TABLE save_failures RENAME TO save_failures_away");
  try {
    assert.equal(await recordSaveFailure({ route: "/api/intake", action: "add", error: new Error("boom"), body: {} }), false);
    const { payload } = await call(intake, { action: "add", customerName: "Still (fake)", phone: "8680000801", device: "iPad", issues: "Battery", repairCost: "xyz" });
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Repair cost must be a valid/, "the original error, not the recording error");
  } finally {
    await db.query("ALTER TABLE save_failures_away RENAME TO save_failures");
  }
});

await test("nothing is recorded on a read-only preview", async () => {
  process.env.VERCEL_ENV = "preview";
  try {
    assert.equal(await recordSaveFailure({ route: "/api/intake", action: "add", error: new Error("x"), body: {} }), false);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

console.log(`All ${passed} save-failure tests passed`);
