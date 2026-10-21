// One invoice per client at check-in: a repair logged after its invoice was
// made joins that invoice instead of creating a second one, and a client
// with several active repairs has them all on one invoice. Runs the real
// api/invoice.js + lib/invoices.js against Postgres (PGlite).
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
const { addTicket, updateTicket } = await import("../lib/tickets.js");
const { getInvoiceForTicket, listInvoices } = await import("../lib/invoices.js");
const merge = await import("../lib/invoice-merge.js");
const { default: handler } = await import("../api/invoice.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; }, send() { return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const line = (description, rate) => ({ description, detail: "", qty: 1, rate });
const invoicesFor = async (phone) => (await listInvoices()).filter((inv) => merge.phoneKey(inv.billTo.phone) === merge.phoneKey(phone));

// What check-in does: log the repair(s), then ask for their invoice.
async function checkIn(client, devices, extra = {}) {
  const tickets = [];
  for (const d of devices) {
    tickets.push(await addTicket({ customerName: client.name, phone: client.phone, email: client.email || "", device: d.device, issues: d.issues, repairCost: String(d.cost), amountPaid: String(d.paid || 0) }));
  }
  const data = await api({
    action: "checkin",
    billTo: client,
    devices: devices.map((d, i) => ({ ticketId: tickets[i].id, device: d.device, items: [line(`${d.device} ${d.repair}`, d.cost)], amountPaid: String(d.paid || 0) })),
    useDefaultNotes: true,
    ...extra,
  });
  return { tickets, ...data };
}

console.log("Bug 1 — invoice made before the repair is logged");

await test("the repair joins the existing invoice; no second invoice is created", async () => {
  const client = { name: "Anita Singh", phone: "868-712-3456" };
  const made = await api({ action: "create", billTo: { name: "Anita Singh", phone: "8687123456" }, items: [line("iPhone 13 Screen Replacement", 900)], paymentMade: 200 });
  assert.deepEqual(made.invoice.ticketIds, []);

  const candidate = await api({ action: "checkinCandidate", billTo: client, devices: [{ device: "iPhone 13" }] });
  assert.equal(candidate.invoice.id, made.invoice.id, "check-in offers the invoice that was made first");
  assert.equal(candidate.reason, "unlinked");

  const { tickets, invoice, merged } = await checkIn({ ...client, email: "anita@example.com" }, [{ device: "iPhone 13", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 900 }]);
  assert.equal(invoice.id, made.invoice.id, "same invoice");
  assert.equal(merged.reason, "unlinked");
  assert.deepEqual(merged.alreadyBilled, ["iPhone 13"]);
  assert.deepEqual(invoice.items.map((i) => i.description), ["iPhone 13 Screen Replacement"], "the line isn't billed twice");
  assert.deepEqual(invoice.ticketIds, [tickets[0].id], "invoice now linked to the repair");
  assert.equal(invoice.paymentMade, 200, "deposit taken on the invoice is kept");
  assert.equal(invoice.billTo.email, "anita@example.com", "email from check-in filled in");
  assert.equal((await getInvoiceForTicket(tickets[0].id)).id, made.invoice.id, "the repair card opens that invoice");
  assert.equal((await invoicesFor(client.phone)).length, 1, "still only one invoice for the client");
});

await test("an invoice for a different device still joins, with the new device's lines added", async () => {
  const client = { name: "Ravi Persad", phone: "8685550101" };
  const made = await api({ action: "create", billTo: client, items: [line("Tempered Glass", 80)], paymentMade: 0 });
  const { invoice, merged } = await checkIn(client, [{ device: "Pixel 6", repair: "Battery Replacement", issues: "Battery Issue", cost: 600 }]);
  assert.equal(invoice.id, made.invoice.id);
  assert.deepEqual(merged.added, ["Pixel 6"]);
  assert.deepEqual(invoice.items.map((i) => i.description), ["Tempered Glass", "Pixel 6 Battery Replacement"]);
  assert.equal(invoice.total, 680);
});

await test("another client with the same name but a different phone is not merged", async () => {
  await api({ action: "create", billTo: { name: "John Ali", phone: "8681110000" }, items: [line("Pixel 7 Screen Replacement", 1000)] });
  const { invoice, merged } = await checkIn({ name: "John Ali", phone: "8682220000" }, [{ device: "Pixel 7", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 1000 }]);
  assert.equal(merged, null, "new invoice");
  assert.equal((await invoicesFor("8681110000"))[0].ticketIds.length, 0, "the other John's invoice is untouched");
  assert.equal(invoice.billTo.phone, "8682220000");
});

await test("old or deleted unlinked invoices are not picked up", async () => {
  const client = { name: "Old Invoice", phone: "8683330000" };
  const old = await api({ action: "create", billTo: client, items: [line("iPad 9 Screen Replacement", 700)] });
  await db.query("UPDATE custom_invoices SET created_at = now() - interval '45 days' WHERE id = $1", [old.invoice.id]);
  const gone = await api({ action: "create", billTo: client, items: [line("iPad 9 Screen Replacement", 700)] });
  await api({ action: "delete", id: gone.invoice.id });
  const { merged } = await checkIn(client, [{ device: "iPad 9", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 700 }]);
  assert.equal(merged, null);
});

console.log("Bug 2 — two or more active repairs share one invoice");

await test("devices logged on separate visits all go on the client's one invoice", async () => {
  const client = { name: "Maria Lopez", phone: "8684440000" };
  const first = await checkIn(client, [{ device: "iPhone 12", repair: "Battery Replacement", issues: "Battery Issue", cost: 500, paid: 100 }]);
  assert.equal(first.merged, null, "first device starts the invoice");

  const second = await checkIn(client, [{ device: "Galaxy S21", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 1200, paid: 300 }]);
  assert.equal(second.invoice.id, first.invoice.id, "second device joins it");
  assert.equal(second.merged.reason, "active");
  assert.deepEqual(second.invoice.items.map((i) => i.description), ["iPhone 12 Battery Replacement", "Galaxy S21 Screen Replacement"]);
  assert.equal(second.invoice.total, 1700);
  assert.equal(second.invoice.paymentMade, 400, "both repairs' payments");
  assert.equal(second.invoice.balanceDue, 1300);

  const third = await checkIn(client, [{ device: "iPhone 12", repair: "Charging Port", issues: "Charging Port", cost: 450 }]);
  assert.equal(third.invoice.id, first.invoice.id, "a second unit of the same model joins too");
  assert.equal(third.invoice.items.length, 3, "and its line is added, not mistaken for the first iPhone 12");
  assert.deepEqual(third.invoice.ticketIds, [...first.tickets, ...second.tickets, ...third.tickets].map((t) => t.id));
  assert.equal((await invoicesFor(client.phone)).length, 1, "one invoice for all three active repairs");
});

await test("several devices logged together make one invoice", async () => {
  const client = { name: "Kevin Ramdial", phone: "8685550000" };
  const { invoice, merged, tickets } = await checkIn(client, [
    { device: "Pixel 8", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 1100 },
    { device: "Nintendo Switch", repair: "Charging Port", issues: "Charging Port", cost: 400 },
  ]);
  assert.equal(merged, null);
  assert.deepEqual(invoice.ticketIds, tickets.map((t) => t.id));
  assert.equal(invoice.total, 1500);
});

await test("once the earlier repairs are picked up, the next visit gets a new invoice", async () => {
  const client = { name: "Done Before", phone: "8686660000" };
  const first = await checkIn(client, [{ device: "iPhone 11", repair: "Battery Replacement", issues: "Battery Issue", cost: 450, paid: 450 }]);
  await updateTicket({ id: first.tickets[0].id, status: "Picked Up" });
  const next = await checkIn(client, [{ device: "iPhone 11", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 800 }]);
  assert.equal(next.merged, null);
  assert.notEqual(next.invoice.id, first.invoice.id);
});

await test("staff can still choose \"Create a new invoice\"", async () => {
  const client = { name: "Wants Two", phone: "8687770000" };
  const first = await checkIn(client, [{ device: "Pixel 6", repair: "Battery Replacement", issues: "Battery Issue", cost: 600 }]);
  const forced = await checkIn(client, [{ device: "Pixel 7", repair: "Screen Replacement", issues: "Screen Cracked / Broken", cost: 1000 }], { invoiceId: "new" });
  assert.equal(forced.merged, null);
  assert.notEqual(forced.invoice.id, first.invoice.id);
});

console.log("Matching rules");

await test("a line for a longer model isn't taken for the shorter one", () => {
  assert.equal(merge.itemsMentionDevice([line("iPhone 13 Pro Screen Replacement", 1)], "iPhone 13"), false);
  assert.equal(merge.itemsMentionDevice([line("iPhone 13 Screen Replacement", 1)], "iPhone 13"), true);
  assert.equal(merge.itemsMentionDevice([line("iPhone 13 Tempered Glass", 1)], "iPhone 13"), false, "accessories aren't the repair");
});

await test("same client by phone digits, or by name when there's no phone", () => {
  assert.equal(merge.sameClient({ name: "A", phone: "(868) 712-3456" }, { name: "B", phone: "7123456" }), true);
  assert.equal(merge.sameClient({ name: "Anita", phone: "" }, { name: " anita ", phone: "" }), true);
  assert.equal(merge.sameClient({ name: "Anita", phone: "8681111111" }, { name: "Anita", phone: "8682222222" }), false);
});

await test("a deposit isn't counted twice when the same money is typed again at check-in", () => {
  assert.equal(merge.mergedPaymentMade({ invoicePaid: 200, linkedPaid: 0, newPaid: 200 }), 200);
  assert.equal(merge.mergedPaymentMade({ invoicePaid: 100, linkedPaid: 100, newPaid: 300 }), 400);
});

console.log(`checkin invoice tests passed (${passed})`);
