// A Vercel preview deployment that shares the live database must not change
// it: writes are refused (503 at the API, READ ONLY at the database), schema
// changes don't run, and reads still work. Production is unchanged. Also: the
// lead-notes dedupe cleanup now runs once, so repeated notes survive.
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
delete process.env.PREVIEW_DATABASE_URL;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema, sql, isReadOnlyDeployment } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: intake } = await import("../api/intake.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function call(method, body) {
  let payload; let status = 200;
  const response = { setHeader() {}, status(s) { status = s; return this; }, json(v) { payload = v; return this; }, end() { return this; } };
  const req = method === "GET"
    ? { method, headers: {}, query: { pin: "0000", ...body } }
    : { method, headers: {}, body: JSON.stringify({ pin: "0000", ...body }) };
  await intake(req, response);
  return { status, payload };
}
const ticketCount = async () => Number((await db.query("SELECT count(*) AS n FROM tickets")).rows[0].n);
const asEnv = (env, preview) => {
  if (env) process.env.VERCEL_ENV = env; else delete process.env.VERCEL_ENV;
  if (preview) process.env.PREVIEW_DATABASE_URL = preview; else delete process.env.PREVIEW_DATABASE_URL;
};

const { payload: seeded } = await call("POST", { action: "add", customerName: "Seed (fake)", phone: "8680000700", device: "iPhone 12", issues: "Battery", repairCost: "300" });
assert.equal(seeded.ok, true, seeded.error);

await test("local runs and production are not read-only", async () => {
  asEnv("");
  assert.equal(isReadOnlyDeployment(), false);
  asEnv("production");
  assert.equal(isReadOnlyDeployment(), false);
  const { status, payload } = await call("POST", { action: "add", customerName: "Prod (fake)", phone: "8680000701", device: "Pixel 7", issues: "Screen", repairCost: "500" });
  assert.equal(status, 200);
  assert.equal(payload.ok, true, payload.error);
});

await test("a preview sharing the live database refuses POST with a 503", async () => {
  asEnv("preview");
  assert.equal(isReadOnlyDeployment(), true);
  const before = await ticketCount();
  const { status, payload } = await call("POST", { action: "add", customerName: "Preview (fake)", phone: "8680000702", device: "iPad", issues: "Battery", repairCost: "400" });
  assert.equal(status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.previewReadOnly, true);
  assert.match(payload.error, /Preview deployments are read-only/);
  assert.equal(await ticketCount(), before, "nothing was written");
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal((await call(method, { action: "delete", id: seeded.ticket.id })).status, 503, method);
});

await test("…but reads still work on the preview (listing repairs skips its reminder sync)", async () => {
  asEnv("preview");
  const { status, payload } = await call("GET", { action: "list" });
  assert.equal(status, 200);
  assert.equal(payload.ok, true, payload.error);
  assert.ok(payload.tickets.some((t) => t.id === seeded.ticket.id));
});

await test("…and the database itself refuses a write that slips through (even via GET)", async () => {
  asEnv("preview");
  const before = await ticketCount();
  const { payload } = await call("GET", { action: "add", customerName: "Sneaky (fake)", phone: "8680000703", device: "iPad", issues: "Battery", repairCost: "1" });
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Preview deployments are read-only/);
  await assert.rejects(sql`INSERT INTO app_settings (key, value) VALUES ('preview-probe', '{}'::jsonb)`, /Preview deployments are read-only/);
  await assert.rejects(sql.transaction([sql`UPDATE tickets SET notes = 'x'`]), /Preview deployments are read-only/);
  assert.equal(await ticketCount(), before);
});

await test("no schema change or backfill runs on the preview", async () => {
  asEnv("preview");
  await db.query("DELETE FROM app_settings WHERE key = 'lead_notes_dedupe_done'");
  // A fresh copy of lib/db.js is a fresh cold start.
  const fresh = await import("../lib/db.js?preview-cold-start");
  await fresh.ensureSchema();
  const rows = (await db.query("SELECT 1 FROM app_settings WHERE key = 'lead_notes_dedupe_done'")).rows;
  assert.equal(rows.length, 0, "ensureSchema did nothing");
  // Put the marker back, as on the live database where the cleanup already ran.
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('lead_notes_dedupe_done', '{}'::jsonb)`);
});

await test("a preview with its own PREVIEW_DATABASE_URL works normally", async () => {
  asEnv("preview", "pglite://separate-preview-db");
  assert.equal(isReadOnlyDeployment(), false);
  const { status, payload } = await call("POST", { action: "add", customerName: "Own DB (fake)", phone: "8680000704", device: "iPad", issues: "Battery", repairCost: "400" });
  assert.equal(status, 200);
  assert.equal(payload.ok, true, payload.error);
});

await test("schema changes are safe to run twice, and repeated lead notes now survive cold starts", async () => {
  asEnv("");
  await db.query("INSERT INTO leads (id, customer_name) VALUES ('LFAKE1', 'Lead (fake)')");
  await db.query("INSERT INTO lead_notes (lead_id, note, created_at) VALUES ('LFAKE1', 'Called, no answer', now() - interval '2 days'), ('LFAKE1', 'Called, no answer', now())");
  for (const tag of ["cold-start-a", "cold-start-b"]) {
    const fresh = await import(`../lib/db.js?${tag}`);
    await fresh.ensureSchema(); // must not throw the second time either
  }
  const notes = (await db.query("SELECT count(*) AS n FROM lead_notes WHERE lead_id = 'LFAKE1'")).rows[0].n;
  assert.equal(Number(notes), 2, "both 'Called, no answer' notes are still there");
});

asEnv("");
console.log(`All ${passed} preview / migration safety tests passed`);
