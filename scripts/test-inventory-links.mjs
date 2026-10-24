// Inventory ↔ price list links, through the real api/inventory.js handler: a
// part added with a device + repair is linked by its inventory key, the link
// comes back with every inventory response, and it can be changed or removed.
// The Google Sheet (CSV export, Sheets API, OAuth) is stubbed with fetch.
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
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "test@example.iam.gserviceaccount.com";
process.env.GOOGLE_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));

// A tiny sheet: SCREENS has a quality column, BATTERIES doesn't.
let sheet = [
  ["SCREENS"],
  ["Device", "Quality", "Quantity"],
  ["13 Pro", "Soft", "2"],
  [""],
  ["BATTERIES"],
  ["Device", "Quantity"],
  ["iPhone 12", "0"],
];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  if (href.includes("/export?format=csv")) {
    const csv = sheet.map((row) => row.join(",")).join("\n");
    return { ok: true, status: 200, text: async () => csv };
  }
  if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "token", expires_in: 3600 });
  if (href.includes("?fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 85811363, title: "Inventory" } }] });
  if (href.endsWith("/values:batchUpdate")) {
    for (const entry of JSON.parse(init.body).data) {
      const [, col, row] = entry.range.match(/!([A-Z]+)(\d+)$/);
      sheet[Number(row) - 1][col.charCodeAt(0) - 65] = String(entry.values[0][0]);
    }
    return json({});
  }
  if (href.endsWith(":batchUpdate")) {
    const start = JSON.parse(init.body).requests[0].insertDimension.range.startIndex;
    sheet.splice(start, 0, ["", "", ""]);
    return json({});
  }
  throw new Error("Unexpected fetch: " + href);
};

const { default: handler } = await import("../api/inventory.js");

async function call(method, body) {
  const req = { method, headers: { "x-forwarded-for": "10.0.0.1" }, body: body ? JSON.stringify(body) : undefined };
  let payload;
  const res = {
    setHeader() { return res; },
    status() { return res; },
    json(data) { payload = data; return res; },
    end() { return res; },
  };
  await handler(req, res);
  return payload;
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("ok -", name);
  } catch (err) {
    failures += 1;
    console.error("not ok -", name, "\n", err);
  }
}

await test("inventory loads with no links yet", async () => {
  const data = await call("GET");
  assert.equal(data.ok, true, data.error);
  assert.deepEqual(data.links, []);
  assert.equal(data.items.length, 2);
});

await test("adding an item with a device + repair links it by its inventory key", async () => {
  const data = await call("POST", {
    action: "addItem", pin: "1234", section: "SCREENS", item: "iPhone 14 ", quality: "Incell", quantity: "3",
    link: { model: "iPhone  14", repairType: "Incell Screen" },
  });
  assert.equal(data.ok, true, data.error);
  assert.equal(data.linkError, "");
  const item = data.items.find((candidate) => candidate.item === "iPhone 14");
  assert.ok(item, "new row is in the sheet");
  assert.equal(item.quantity, 3);
  assert.deepEqual(data.links, [{ itemKey: item.key, modelKey: "iphone 14", model: "iPhone 14", repairType: "Incell Screen" }]);
  const again = await call("GET");
  assert.deepEqual(again.links, data.links);
});

await test("a link needs both the device and the repair, and nothing is added without them", async () => {
  const before = sheet.length;
  const data = await call("POST", {
    action: "addItem", pin: "1234", section: "BATTERIES", item: "iPhone 15", quantity: "1",
    link: { model: "iPhone 15", repairType: "" },
  });
  assert.equal(data.ok, false);
  assert.match(data.error, /device and the repair/);
  assert.equal(sheet.length, before);
});

await test("adding without a link leaves the links alone", async () => {
  const data = await call("POST", { action: "addItem", pin: "1234", section: "BATTERIES", item: "iPhone 15", quantity: "1" });
  assert.equal(data.ok, true, data.error);
  assert.equal(data.links.length, 1);
});

await test("existing items can be relinked and unlinked", async () => {
  const { items } = await call("GET");
  const battery = items.find((candidate) => candidate.item === "iPhone 12");
  let data = await call("POST", { action: "linkItem", pin: "1234", itemKey: battery.key, model: "iPhone 12", repairType: "Battery" });
  assert.equal(data.ok, true, data.error);
  assert.equal(data.links.length, 2);
  data = await call("POST", { action: "linkItem", pin: "1234", itemKey: battery.key, model: "iPhone 12 Pro", repairType: "Battery" });
  assert.equal(data.links.find((link) => link.itemKey === battery.key).modelKey, "iphone 12 pro");
  data = await call("POST", { action: "unlinkItem", pin: "1234", itemKey: battery.key });
  assert.equal(data.ok, true, data.error);
  assert.equal(data.links.some((link) => link.itemKey === battery.key), false);
});

await test("linking needs the team PIN", async () => {
  const data = await call("POST", { action: "linkItem", pin: "0000", itemKey: "screens|13 pro|soft", model: "iPhone 13 Pro", repairType: "Screen" });
  assert.equal(data.ok, false);
});

if (failures) {
  console.error(`${failures} inventory link test(s) failed`);
  process.exit(1);
}
console.log("All inventory link tests passed");
