// Devices Under Warranty, claiming a warranty, the per-device "hide the parts
// notice" display option, and an invoice update moving its repair from
// Received to Part to be Ordered. All on fake repairs, against Postgres
// (PGlite) through the real api/intake.js and api/invoice.js handlers.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
process.env.PUBLIC_APP_URL = "https://repairs.example";
delete process.env.RESEND_API_KEY;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: intake } = await import("../api/intake.js");
const { default: invoiceApi } = await import("../api/invoice.js");
const { sql } = await import("../lib/db.js");
const { WARRANTY_DAYS } = await import("../lib/tickets.js");
const { updateDevice, getDevice, setPartsAlertForAll, registerDevice } = await import("../lib/devices.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function call(handler, body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; }, send() { return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  return payload;
}
async function ok(handler, body) {
  const payload = await call(handler, body);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const repairs = (body) => ok(intake, body);
const ticketById = async (id) => (await repairs({ action: "list" })).tickets.find((t) => t.id === id);

// ---- Warranty ---------------------------------------------------------------
const { ticket: fixed } = await repairs({ action: "add", customerName: "Warranty Client (fake)", phone: "8680000010", device: "iPhone 13", issues: "Screen Cracked / Broken", repairCost: "800", amountPaid: "800", paymentMethod: "cash" });

await test("picking a repair up starts its warranty clock", async () => {
  assert.equal(fixed.pickedUpAt, null);
  const { ticket } = await repairs({ action: "update", id: fixed.id, status: "Picked Up" });
  assert.ok(ticket.pickedUpAt, "pickedUpAt set");
  assert.ok(Date.now() - new Date(ticket.pickedUpAt).getTime() < 60_000);
});

await test("a repair that isn't picked up can't be claimed", async () => {
  const { ticket } = await repairs({ action: "add", customerName: "Fake", phone: "8680000011", device: "Pixel 7", issues: "Battery", repairCost: "300" });
  const res = await call(intake, { action: "claimWarranty", id: ticket.id, problem: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error, /picked up/);
});

await test("a claim needs a description of the problem", async () => {
  const res = await call(intake, { action: "claimWarranty", id: fixed.id, problem: "  " });
  assert.equal(res.ok, false);
  assert.match(res.error, /what's wrong/);
});

let claim;
await test("claim warranty opens a free, linked repair and notes it on the original", async () => {
  const res = await repairs({ action: "claimWarranty", id: fixed.id, problem: "Touch not responding on the left side" });
  claim = res.ticket;
  assert.equal(claim.warrantyOf, fixed.id);
  assert.equal(claim.status, "Received");
  assert.equal(claim.customerName, "Warranty Client (fake)");
  assert.equal(claim.device, "iPhone 13");
  assert.equal(Number(claim.repairCost), 0);
  assert.equal(Number(claim.amountPaid), 0);
  assert.match(claim.notes, new RegExp(`Warranty claim on repair #${fixed.id}.*Touch not responding`));
  assert.match(res.original.history, new RegExp(`Warranty claimed — new repair #${claim.id}: Touch not responding`));
  assert.equal(res.original.status, "Picked Up", "the original stays completed");
});

await test("a warranty claim can't itself be claimed on", async () => {
  await repairs({ action: "update", id: claim.id, status: "Picked Up" });
  const res = await call(intake, { action: "claimWarranty", id: claim.id, problem: "again" });
  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp(`original repair #${fixed.id}`));
});

await test(`after ${WARRANTY_DAYS} days the warranty has ended`, async () => {
  const { ticket: old } = await repairs({ action: "add", customerName: "Old Client (fake)", phone: "8680000012", device: "Galaxy S21", issues: "Charging port", repairCost: "350", amountPaid: "350" });
  await repairs({ action: "update", id: old.id, status: "Picked Up" });
  await sql`UPDATE tickets SET picked_up_at = now() - interval '61 days' WHERE id = ${old.id}`;
  const res = await call(intake, { action: "claimWarranty", id: old.id, problem: "Port loose" });
  assert.equal(res.ok, false);
  assert.match(res.error, /warranty on this repair has ended/);
  await sql`UPDATE tickets SET picked_up_at = now() - interval '59 days' WHERE id = ${old.id}`;
  await repairs({ action: "claimWarranty", id: old.id, problem: "Port loose" });
});

await test("taking a repair back off Picked Up clears its warranty clock", async () => {
  const { ticket } = await repairs({ action: "update", id: fixed.id, status: "Repaired" });
  assert.equal(ticket.pickedUpAt, null);
});

await test("repairs picked up before the column existed are backfilled from the log", async () => {
  const { ticket } = await repairs({ action: "add", customerName: "Backfill (fake)", phone: "8680000013", device: "iPad Air", issues: "Screen", repairCost: "900", amountPaid: "900" });
  await repairs({ action: "update", id: ticket.id, status: "Picked Up" });
  await sql`UPDATE tickets SET picked_up_at = NULL WHERE id = ${ticket.id}`;
  await db.exec(readFileSync(new URL("052_add_warranty_and_device_display.sql", migrations), "utf8"));
  const after = await ticketById(ticket.id);
  assert.ok(after.pickedUpAt, "backfilled");
});

// ---- Device display option ----------------------------------------------------
await test("a device can hide the parts notice; it's off by default", async () => {
  const device = await getDevice("DEVICE_FAKE_1", { userAgent: "Mozilla/5.0 (iPad)" });
  assert.equal(device.hidePartsAlert, false);
  const saved = await updateDevice({ id: device.id, hidePartsAlert: true });
  assert.equal(saved.hidePartsAlert, true);
  // Changing the name or permissions leaves it alone.
  const renamed = await updateDevice({ id: device.id, name: "Front counter", hidden: [] });
  assert.equal(renamed.hidePartsAlert, true);
  assert.equal((await updateDevice({ id: device.id, hidePartsAlert: false })).hidePartsAlert, false);
});

await test("one button turns the parts notice off (and back on) on every device, including new ones", async () => {
  await getDevice("DEVICE_FAKE_2", { userAgent: "Mozilla/5.0 (iPhone)" });
  await getDevice("DEVICE_FAKE_3", { userAgent: "Mozilla/5.0 (Windows)" });
  const changed = await setPartsAlertForAll(true);
  assert.ok(changed >= 3, String(changed));
  const all = await sql`SELECT bool_and(hide_parts_alert) AS all_hidden FROM devices`;
  assert.equal(all[0].all_hidden, true);
  await registerDevice("DEVICE_FAKE_NEW", { userAgent: "Mozilla/5.0 (Android)" });
  assert.equal((await getDevice("DEVICE_FAKE_NEW")).hidePartsAlert, true, "a device signing in later starts hidden");
  await setPartsAlertForAll(false);
  const none = await sql`SELECT bool_or(hide_parts_alert) AS any_hidden FROM devices`;
  assert.equal(none[0].any_hidden, false);
  await registerDevice("DEVICE_FAKE_NEW_2", { userAgent: "Mozilla/5.0 (Android)" });
  assert.equal((await getDevice("DEVICE_FAKE_NEW_2")).hidePartsAlert, false);
});

// ---- Invoice ↔ repair status ----------------------------------------------------
async function repairWithInvoice(name, phone) {
  const { ticket } = await repairs({ action: "add", customerName: name, phone, device: "iPhone 12", issues: "Screen Cracked / Broken", repairCost: "650" });
  const created = await ok(invoiceApi, {
    action: "create",
    billTo: { name, phone, email: "" },
    items: [{ description: "iPhone 12 screen — quote", detail: "", qty: 1, rate: 650 }],
  });
  const { invoice } = await ok(invoiceApi, { action: "update", id: created.invoice.id, invoice: { ticketIds: [ticket.id] } });
  return { ticket, invoice };
}

await test("updating the invoice in the editor moves its Received repair to Part to be Ordered", async () => {
  const { ticket, invoice } = await repairWithInvoice("Confirmed Client (fake)", "8680000020");
  const res = await ok(invoiceApi, {
    action: "update", id: invoice.id, fromEditor: true,
    invoice: { items: [{ description: "iPhone 12 screen — confirmed (OLED)", detail: "", qty: 1, rate: 700 }] },
  });
  assert.deepEqual(res.repairsMoved.map((m) => [m.id, m.from, m.to]), [[ticket.id, "Received", "Part to be Ordered"]]);
  const after = await ticketById(ticket.id);
  assert.equal(after.status, "Part to be Ordered");
  assert.match(after.history, /Status: Received → Part to be Ordered/);
});

await test("saving the editor without changing anything leaves the repair alone", async () => {
  const { ticket, invoice } = await repairWithInvoice("Unchanged Client (fake)", "8680000021");
  const res = await ok(invoiceApi, { action: "update", id: invoice.id, fromEditor: true, invoice: { items: invoice.items, notes: invoice.notes } });
  assert.deepEqual(res.repairsMoved, []);
  assert.equal((await ticketById(ticket.id)).status, "Received");
});

await test("repair → invoice syncs (not the editor) never move the status", async () => {
  const { ticket, invoice } = await repairWithInvoice("Sync Client (fake)", "8680000022");
  const res = await ok(invoiceApi, { action: "update", id: invoice.id, invoice: { paymentMade: 100 } });
  assert.deepEqual(res.repairsMoved, []);
  assert.equal((await ticketById(ticket.id)).status, "Received");
});

await test("only repairs at Received move — later statuses are left as they are", async () => {
  const { ticket, invoice } = await repairWithInvoice("Diagnosing Client (fake)", "8680000023");
  await repairs({ action: "update", id: ticket.id, status: "Diagnosing" });
  const res = await ok(invoiceApi, { action: "update", id: invoice.id, fromEditor: true, invoice: { notes: "Client confirmed by phone" } });
  assert.deepEqual(res.repairsMoved, []);
  assert.equal((await ticketById(ticket.id)).status, "Diagnosing");
});

console.log(`All ${passed} warranty / device display / invoice status tests passed`);
