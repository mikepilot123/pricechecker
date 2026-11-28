// Parts check queue: only the master device, only with the owner PIN; finished
// repairs wait in the queue; each answer (stock / bought / none) is recorded
// once — stock comes off the inventory sheet, a bought part becomes an
// expense linked to the repair. The Google Sheet is stubbed with fetch.
import { registerHooks } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "1234";
delete process.env.VERCEL_ENV;
delete process.env.OWNER_PIN;
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "test@example.iam.gserviceaccount.com";
process.env.GOOGLE_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));

let sheet = [["SCREENS"], ["Device", "Quality", "Quantity"], ["iPhone 13", "OLED", "3"]];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (href.includes("/export?format=csv")) return { ok: true, status: 200, text: async () => sheet.map((r) => r.join(",")).join("\n") };
  if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "token", expires_in: 3600 });
  if (href.includes("?fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 85811363, title: "Inventory" } }] });
  if (/\/values\/[^:]+!([A-Z]+)(\d+)\?valueInputOption/.test(href)) {
    const [, col, row] = href.match(/!([A-Z]+)(\d+)\?/);
    sheet[Number(row) - 1][col.charCodeAt(0) - 65] = String(JSON.parse(init.body).values[0][0]);
    return json({});
  }
  if (href.endsWith("/values:batchUpdate")) {
    for (const entry of JSON.parse(init.body).data) {
      const [, col, row] = entry.range.match(/!([A-Z]+)(\d+)$/);
      sheet[Number(row) - 1][col.charCodeAt(0) - 65] = String(entry.values[0][0]);
    }
    return json({});
  }
  throw new Error("Unexpected fetch: " + href);
};
const { default: intake } = await import("../api/intake.js");
const { listInventory } = await import("../lib/inventory.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function call(body, pin = "1234") {
  let payload; let status = 200;
  const response = { setHeader() {}, status(s) { status = s; return this; }, json(v) { payload = v; return this; } };
  await intake({ method: "POST", headers: { "user-agent": "test" }, body: JSON.stringify({ pin, ...body }) }, response);
  return { status, payload };
}
const ok = async (body, pin) => { const r = await call(body, pin); assert.equal(r.payload.ok, true, r.payload.error); return r.payload; };

const owner = (await ok({ action: "registerBrowser" })).credential;   // the owner's login on the laptop
const staff = (await ok({ action: "registerBrowser" })).credential;   // the employee's login on the same laptop
await ok({ action: "setOwnerPin", newOwnerPin: "9876" }, owner);
const { deviceId: ownerDevice } = await ok({ action: "deviceAccess" }, owner);

const finished = async (name, extra = {}) => {
  const { ticket } = await ok({ action: "add", customerName: name, phone: "8680001200", device: "iPhone 13", issues: "Screen Cracked / Broken", repairCost: "800", ...extra });
  await ok({ action: "update", id: ticket.id, status: "Picked Up" });
  return ticket;
};

await test("only the owner PIN can make a device the master", async () => {
  const denied = await call({ action: "setMasterDevice", id: ownerDevice, master: true, ownerPin: "0000" }, owner);
  assert.notEqual(denied.payload.ok, true);
  const { master, devices } = await ok({ action: "setMasterDevice", id: ownerDevice, master: true, ownerPin: "9876" }, owner);
  assert.equal(master.id, ownerDevice);
  assert.ok(master.since);
  assert.equal(devices.find((d) => d.id === ownerDevice).isMaster, true);
  assert.equal((await ok({ action: "deviceAccess" }, owner)).isMaster, true);
  assert.equal((await ok({ action: "deviceAccess" }, staff)).isMaster, false, "the other login on the same laptop isn't master");
});

let a, b, c;
await test("finished repairs wait in the queue (not unfinished ones, not ones with stock chosen)", async () => {
  a = await finished("Stock Fake (test)");
  b = await finished("Bought Fake (test)");
  c = await finished("Labour Fake (test)");
  await ok({ action: "add", customerName: "Still Open (fake)", phone: "8680001201", device: "Pixel 8", issues: "Battery", repairCost: "300" });
  const { tickets } = await ok({ action: "partsCheckList", ownerPin: "9876" }, owner);
  assert.deepEqual(tickets.map((t) => t.id).sort(), [a.id, b.id, c.id].sort());
});

await test("other devices — or no owner PIN — can't see or confirm the queue", async () => {
  assert.equal((await call({ action: "partsCheckList", ownerPin: "9876" }, staff)).status, 403);
  assert.notEqual((await call({ action: "partsCheckList", ownerPin: "1111" }, owner)).payload.ok, true);
  assert.notEqual((await call({ action: "recordPartsCheck", id: c.id, choice: "none", ownerPin: "9876" }, staff)).payload.ok, true);
});

await test("from stock: one comes off the inventory sheet", async () => {
  const [item] = (await listInventory()).items;
  const { ticket } = await ok({ action: "recordPartsCheck", id: a.id, choice: "stock", inventoryItemKey: item.key, ownerPin: "9876" }, owner);
  assert.equal(ticket.partsCheck, "stock");
  assert.equal(sheet[2][2], "2", "3 → 2 in stock");
  assert.match(ticket.history, /Parts check: used .* from stock/);
});

await test("bought for it: an expense (Parts) linked to the repair", async () => {
  const { ticket, expense } = await ok({ action: "recordPartsCheck", id: b.id, choice: "expense", amount: "350", vendor: "Mobile Sentrix", date: "2026-11-28", ownerPin: "9876" }, owner);
  assert.equal(ticket.partsCheck, "expense");
  assert.equal(ticket.partsCheckExpenseId, expense.id);
  assert.equal(expense.category, "Parts");
  assert.equal(Number(expense.amount), 350);
  assert.match(expense.notes, new RegExp(`repair #${b.id}`));
  assert.match(ticket.history, /paid Mobile Sentrix TT\$350\.00 for this repair/);
});

await test("no part needed, and each repair is only checked once", async () => {
  await ok({ action: "recordPartsCheck", id: c.id, choice: "none", ownerPin: "9876" }, owner);
  const again = await call({ action: "recordPartsCheck", id: c.id, choice: "expense", amount: "10", ownerPin: "9876" }, owner);
  assert.equal(again.payload.ok, false);
  assert.match(again.payload.error, /already done/);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM expenses")).rows[0].n), 1, "no second expense");
  assert.equal((await ok({ action: "partsCheckList", ownerPin: "9876" }, owner)).tickets.length, 0, "queue empty");
});

await test("bad answers are refused", async () => {
  const d = await finished("Bad Fake (test)");
  for (const body of [{ choice: "maybe" }, { choice: "expense", amount: "0", vendor: "Ainsley" }, { choice: "expense", amount: "100" }, { choice: "stock" }]) {
    assert.equal((await call({ action: "recordPartsCheck", id: d.id, ownerPin: "9876", ...body }, owner)).payload.ok, false, JSON.stringify(body));
  }
});

await test("fully paid (not finished) repairs are asked; ones with an expense naming them aren't", async () => {
  const { ticket: paid } = await ok({ action: "add", customerName: "Paid Fake (test)", phone: "8680001202", device: "iPhone 12", issues: "Battery", repairCost: "400" });
  await ok({ action: "update", id: paid.id, amountPaid: "400" });
  const { ticket: deposit } = await ok({ action: "add", customerName: "Deposit Fake (test)", phone: "8680001203", device: "iPhone 12", issues: "Battery", repairCost: "400" });
  await ok({ action: "update", id: deposit.id, amountPaid: "100" });
  const logged = await finished("Logged Fake (test)");
  await db.query("INSERT INTO expenses (id, date, category, amount, notes) VALUES ('EXP-T1', '2026-11-28', 'Parts', 120, $1)", [`Screen for ${logged.id}`]);
  const { tickets } = await ok({ action: "partsCheckList", ownerPin: "9876" }, owner);
  const ids = tickets.map((t) => t.id);
  assert.ok(ids.includes(paid.id), "paid in full");
  assert.equal(tickets.find((t) => t.id === paid.id).partsCheckReason, "paid");
  assert.ok(!ids.includes(deposit.id), "only a deposit");
  assert.ok(!ids.includes(logged.id), "an expense already names it");
  const { count } = await ok({ action: "partsCheckCount" }, owner);
  assert.equal(count, tickets.length, "badge count matches the list");
  assert.equal((await call({ action: "partsCheckCount" }, staff)).status, 403);
});

await test("a parts order for the repair comes with the queue item", async () => {
  const t = await finished("Ordered Fake (test)");
  await db.query("INSERT INTO parts_orders (id, batch_id, vendor, part, quantity, unit_cost, ticket_id) VALUES ('PO-T1', 'B1', 'Mobile Sentrix', 'OLED screen', 1, 350, $1)", [t.id]);
  const item = (await ok({ action: "partsCheckList", ownerPin: "9876" }, owner)).tickets.find((x) => x.id === t.id);
  assert.deepEqual(item.partsOrders, [{ vendor: "Mobile Sentrix", part: "OLED screen", quantity: 1, unitCost: 350 }]);
});

await test("supplier cost on the repair: correct what we paid, then switch to nothing spent", async () => {
  // The owner's login can see Accounting (devices start with it hidden).
  await ok({ action: "updateDevice", id: ownerDevice, hidden: [], ownerPin: "9876" }, owner);
  // b was confirmed in the queue as TT$350 to Mobile Sentrix.
  const before = await ok({ action: "getSupplierCost", id: b.id }, owner);
  assert.equal(before.partsCheck, "expense");
  assert.equal(before.expense.amount, 350);
  const changed = await ok({ action: "setSupplierCost", id: b.id, spent: true, amount: "300", vendor: "Ainsley" }, owner);
  assert.equal(changed.expense.id, before.expense.id, "same expense, corrected");
  assert.equal(Number(changed.expense.amount), 300);
  assert.equal(changed.expense.vendor, "Ainsley");
  assert.match(changed.ticket.history, /Supplier cost changed: TT\$350\.00 to Mobile Sentrix → TT\$300\.00 to Ainsley/);
  assert.equal((await call({ action: "setSupplierCost", id: b.id, spent: true, amount: "300" }, owner)).payload.ok, false, "supplier name required");
  const none = await ok({ action: "setSupplierCost", id: b.id, spent: false }, owner);
  assert.equal(none.ticket.partsCheck, "none");
  assert.equal((await db.query("SELECT count(*) AS n FROM expenses WHERE id = $1 AND deleted_at IS NULL", [before.expense.id])).rows[0].n, 0, "expense taken off");
  assert.equal((await ok({ action: "getSupplierCost", id: b.id }, owner)).expense, null);
  // …and back: a new expense.
  const again = await ok({ action: "setSupplierCost", id: b.id, spent: true, amount: "275", vendor: "Ainsley" }, owner);
  assert.equal(again.ticket.partsCheck, "expense");
  assert.notEqual(again.expense.id, before.expense.id);
  // Stock repairs can't be changed here.
  assert.equal((await call({ action: "setSupplierCost", id: a.id, spent: false }, owner)).payload.ok, false);
});

await test("supplier cost straight from a repair that hasn't been through the queue", async () => {
  const t = await finished("Direct Fake (test)");
  const res = await ok({ action: "setSupplierCost", id: t.id, spent: false }, owner);
  assert.equal(res.ticket.partsCheck, "none");
  const queue = (await ok({ action: "partsCheckList", ownerPin: "9876" }, owner)).tickets.map((x) => x.id);
  assert.ok(!queue.includes(t.id), "answered, so out of the queue");
});

await test("overview: recorded repairs (with what was paid) and the past month's unrecorded ones", async () => {
  const { ticket: ordered } = await ok({ action: "add", customerName: "Part Wait Fake (test)", phone: "8680001204", device: "iPhone 13", issues: "Screen Cracked / Broken", repairCost: "700" });
  await ok({ action: "update", id: ordered.id, status: "Part to be Ordered" });
  const { ticket: fresh } = await ok({ action: "add", customerName: "Just In Fake (test)", phone: "8680001205", device: "iPhone 13", issues: "Battery", repairCost: "300" });
  const o = await ok({ action: "partsCheckOverview", ownerPin: "9876" }, owner);
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const rec = byId(o.recorded);
  assert.equal(rec.get(b.id).partsCheck, "expense");
  assert.equal(rec.get(b.id).expense.vendor, "Ainsley");
  assert.equal(rec.get(a.id).partsCheck, "stock");
  assert.equal(rec.get(c.id).partsCheck, "none");
  assert.ok(byId(o.notRecorded).has(ordered.id), "Part to be Ordered shows as not recorded yet");
  assert.ok(!byId(o.notRecorded).has(fresh.id) && !rec.has(fresh.id), "just received: not shown");
  assert.deepEqual(o.pending.map((t) => t.id).sort(), (await ok({ action: "partsCheckList", ownerPin: "9876" }, owner)).tickets.map((t) => t.id).sort());
  assert.equal((await call({ action: "partsCheckOverview", ownerPin: "9876" }, staff)).status, 403);
});

await test("suppliers we've paid are remembered for next time, most used first", async () => {
  const o = await ok({ action: "partsCheckOverview", ownerPin: "9876" }, owner);
  assert.equal(o.suppliers[0], "Ainsley", "used most so far");
  assert.ok(o.suppliers.includes("Mobile Sentrix"));
  assert.equal(o.suppliers.filter((s) => s.toLowerCase() === "ainsley").length, 1, "no duplicates");
  const { suppliers } = await ok({ action: "getSupplierCost", id: b.id }, owner);
  assert.deepEqual(suppliers, o.suppliers);
});

await test("from stock, but not on the inventory sheet: the part's name is noted, the sheet is left alone", async () => {
  const before = sheet.map((r) => r.slice());
  const t = await finished("Off Sheet Fake (test)");
  const { ticket } = await ok({ action: "recordPartsCheck", id: t.id, choice: "stock", stockNote: "Pixel 7 Pro screen (old stock)", ownerPin: "9876" }, owner);
  assert.equal(ticket.partsCheck, "stock");
  assert.equal(ticket.inventoryItemLabel, "Pixel 7 Pro screen (old stock)");
  assert.equal(ticket.inventoryItemKey, "");
  assert.deepEqual(sheet, before, "inventory sheet untouched");
  assert.match(ticket.history, /used Pixel 7 Pro screen \(old stock\) from stock \(not on the inventory sheet\)/);
  const rec = (await ok({ action: "partsCheckOverview", ownerPin: "9876" }, owner)).recorded.find((x) => x.id === t.id);
  assert.equal(rec.stockItem, "Pixel 7 Pro screen (old stock)");
  const t2 = await finished("No Name Fake (test)");
  assert.equal((await call({ action: "recordPartsCheck", id: t2.id, choice: "stock", stockNote: "  ", ownerPin: "9876" }, owner)).payload.ok, false);
});

await test("moving the master keeps the start date; clearing it closes the queue", async () => {
  const before = (await ok({ action: "deviceAccess" }, owner)).partsCheckSince;
  const { deviceId: staffDevice } = await ok({ action: "deviceAccess" }, staff);
  await ok({ action: "setMasterDevice", id: staffDevice, master: true, ownerPin: "9876" }, owner);
  assert.equal((await ok({ action: "deviceAccess" }, owner)).isMaster, false, "only one master");
  assert.equal((await ok({ action: "deviceAccess" }, staff)).partsCheckSince, before);
  await ok({ action: "setMasterDevice", id: staffDevice, master: false, ownerPin: "9876" }, owner);
  assert.equal((await call({ action: "partsCheckList", ownerPin: "9876" }, staff)).status, 403);
});

console.log(`All ${passed} parts-check tests passed`);
