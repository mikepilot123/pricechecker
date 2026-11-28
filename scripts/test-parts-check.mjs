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
  assert.match(ticket.history, /TT\$350\.00 from Mobile Sentrix recorded on Expenses/);
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
  for (const body of [{ choice: "maybe" }, { choice: "expense", amount: "0" }, { choice: "stock" }]) {
    assert.equal((await call({ action: "recordPartsCheck", id: d.id, ownerPin: "9876", ...body }, owner)).payload.ok, false, JSON.stringify(body));
  }
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
