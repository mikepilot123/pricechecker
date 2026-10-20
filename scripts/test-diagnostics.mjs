// Diagnostics are saved against a repair: one record per ticket holding the
// before and after passes, read back from the ticket, and gone from listings
// once the repair is deleted.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addTicket, deleteTicket } = await import("../lib/tickets.js");
const { getTicketDiagnostic, listTicketDiagnostics, saveTicketDiagnostic, deleteTicketDiagnostic } = await import("../lib/diagnostics.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }

const ticket = await addTicket({ customerName: "Dana", phone: "8680000000", device: "iPhone 12", issues: "Screen Cracked / Broken" });
const laptop = await addTicket({ customerName: "Kai", phone: "8681111111", device: "MacBook Air", issues: "Keyboard" });

await test("a repair with no test has no diagnostic", async () => {
  assert.equal(await getTicketDiagnostic(ticket.id), null);
});

await test("saving stores both passes against the repair", async () => {
  const saved = await saveTicketDiagnostic({
    ticketId: ticket.id,
    deviceType: "phone",
    before: { display: "fail", touch: "fail", speaker: "pass" },
    after: {},
    notes: "Cracked top-left",
  });
  assert.deepEqual(saved.before, { display: "fail", touch: "fail", speaker: "pass" });
  const read = await getTicketDiagnostic(ticket.id);
  assert.equal(read.ticketId, ticket.id);
  assert.equal(read.notes, "Cracked top-left");
  assert.deepEqual(read.after, {});
});

await test("saving again replaces the record, including cleared results", async () => {
  await saveTicketDiagnostic({
    ticketId: ticket.id,
    deviceType: "phone",
    before: { display: "fail", speaker: "pass" },
    after: { display: "pass", speaker: "pass" },
    notes: "",
  });
  const read = await getTicketDiagnostic(ticket.id);
  assert.deepEqual(read.before, { display: "fail", speaker: "pass" }, "touch was cleared in the tab");
  assert.deepEqual(read.after, { display: "pass", speaker: "pass" });
  assert.equal(read.notes, "");
});

await test("junk keys and values are dropped, unknown device types fall back to phone", async () => {
  const saved = await saveTicketDiagnostic({
    ticketId: laptop.id,
    deviceType: "toaster",
    before: { keyboard: "fail", "bad key!": "pass", trackpad: "maybe", __proto__x: "pass" },
  });
  assert.equal(saved.deviceType, "phone");
  assert.deepEqual(saved.before, { keyboard: "fail" });
});

await test("listing returns every tested repair", async () => {
  const ids = (await listTicketDiagnostics()).map((d) => d.ticketId).sort();
  assert.deepEqual(ids, [ticket.id, laptop.id].sort());
});

await test("clearing every result and the notes removes the record", async () => {
  assert.equal(await saveTicketDiagnostic({ ticketId: laptop.id, before: {}, after: {}, notes: "  " }), null);
  assert.equal(await getTicketDiagnostic(laptop.id), null);
});

await test("a deleted repair drops out of the listing and can't be saved to", async () => {
  await deleteTicket({ id: ticket.id });
  assert.deepEqual(await listTicketDiagnostics(), []);
  await assert.rejects(() => saveTicketDiagnostic({ ticketId: ticket.id, before: { display: "pass" } }), /Ticket not found/);
});

await test("saving needs a real ticket", async () => {
  await assert.rejects(() => saveTicketDiagnostic({ ticketId: "", before: {} }), /Ticket ID is required/);
  await assert.rejects(() => saveTicketDiagnostic({ ticketId: "NOPE", before: { display: "pass" } }), /Ticket not found/);
});

await test("deleteTicketDiagnostic removes the record", async () => {
  const fresh = await addTicket({ customerName: "Lee", phone: "8682222222", device: "Galaxy S22", issues: "Battery Issue" });
  await saveTicketDiagnostic({ ticketId: fresh.id, before: { battery: "fail" } });
  assert.equal(await deleteTicketDiagnostic({ ticketId: fresh.id }), fresh.id);
  assert.equal(await getTicketDiagnostic(fresh.id), null);
});

console.log(`\n${passed} diagnostics tests passed`);
