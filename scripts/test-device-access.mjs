// Device permissions, through the real api/intake.js handler: nothing changes
// until an owner PIN is set; then browsers registered from now on start with
// every section hidden while ones signed in before keep full access, the data
// behind a hidden section is refused, and only the owner PIN can change it.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "1234";
delete process.env.OWNER_PIN;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));

const { default: handler } = await import("../api/intake.js");
const { createBrowserCredential } = await import("../lib/security.js");

let ipCounter = 0;
async function call(body, { ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1" } = {}) {
  // A fresh IP per call so the PIN lockout never interferes between cases.
  const req = { method: "POST", headers: { "user-agent": ua, "x-forwarded-for": "10.0.0." + (++ipCounter % 250) }, body: JSON.stringify(body) };
  let status = 200;
  let payload;
  const res = {
    setHeader() { return res; },
    status(code) { status = code; return res; },
    json(data) { payload = data; return res; },
    end() { return res; },
  };
  await handler(req, res);
  return { status, ...payload };
}

async function register(ua) {
  const data = await call({ action: "registerBrowser", pin: "1234" }, ua ? { ua } : {});
  assert.equal(data.ok, true, data.error);
  return data.credential;
}

const ALL = ["invoiceFigures", "dashboard", "targets", "accounting"];

// --- Without an owner PIN nothing is restricted ---
const early = await register();
let access = await call({ action: "deviceAccess", pin: early });
assert.equal(access.managed, false);
assert.deepEqual(access.hidden, []);
assert.equal((await call({ action: "listMonthlySales", pin: early })).ok, true);

// --- Owner PIN set: permissions are on ---
process.env.OWNER_PIN = "9999";

// A browser registered from now on starts with everything hidden...
const staff = await register("Mozilla/5.0 (Linux; Android 14; SM-A155F) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36");
access = await call({ action: "deviceAccess", pin: staff });
assert.equal(access.managed, true);
assert.deepEqual(access.hidden, ALL);
assert.ok(access.deviceId.startsWith("D"));
// ...while one signed in before the owner PIN was set keeps full access.
assert.deepEqual((await call({ action: "deviceAccess", pin: early })).hidden, []);

// A credential from before devices were tracked (no row) keeps full access.
const legacy = createBrowserCredential("1234");
access = await call({ action: "deviceAccess", pin: legacy });
assert.deepEqual(access.hidden, []);
assert.equal((await call({ action: "listBankTransactions", pin: legacy })).ok, true);

// A raw team PIN identifies no device, so it's treated as a new one.
assert.deepEqual((await call({ action: "deviceAccess", pin: "1234" })).hidden, ALL);
assert.equal((await call({ action: "listExpenses", pin: "1234" })).status, 403);

// The data behind hidden sections is refused; the rest of the app still works.
for (const action of ["listMonthlySales", "accountSummary", "listBankTransactions", "bankAccountSummary", "listExpenses"]) {
  const denied = await call({ action, pin: staff });
  assert.equal(denied.status, 403, action);
  assert.equal(denied.ok, false);
}
assert.equal((await call({ action: "list", pin: staff })).ok, true);
assert.equal((await call({ action: "listReminders", pin: staff })).ok, true);

// --- Only the owner PIN manages devices ---
assert.match((await call({ action: "listDevices", pin: staff })).error, /owner PIN/i);
assert.match((await call({ action: "listDevices", pin: staff, ownerPin: "1234" })).error, /owner PIN/i);
assert.match((await call({ action: "updateDevice", pin: staff, id: access.deviceId, hidden: [] })).error, /owner PIN/i);

const listed = await call({ action: "listDevices", pin: legacy, ownerPin: "9999" });
assert.equal(listed.ok, true);
assert.equal(listed.devices.length, 3);
const staffDevice = listed.devices.find((d) => d.name === "Android phone · Chrome");
assert.ok(staffDevice, "devices get a readable starting name");
assert.deepEqual(staffDevice.hidden, ALL);

// Allowing the Dashboard opens its data — monthly sales is shared with
// Targets, so one of the two is enough — but Accounting stays shut.
const updated = await call({ action: "updateDevice", pin: legacy, ownerPin: "9999", id: staffDevice.id, name: " Counter  phone ", hidden: ["invoiceFigures", "targets", "accounting", "bogus"] });
assert.equal(updated.ok, true, updated.error);
assert.equal(updated.device.name, "Counter phone");
assert.deepEqual(updated.device.hidden, ["invoiceFigures", "targets", "accounting"]);
assert.deepEqual((await call({ action: "deviceAccess", pin: staff })).hidden, ["invoiceFigures", "targets", "accounting"]);
assert.equal((await call({ action: "listMonthlySales", pin: staff })).ok, true);
assert.equal((await call({ action: "accountSummary", pin: staff })).ok, true);
assert.equal((await call({ action: "listBankTransactions", pin: staff })).status, 403);

// Restricting the device that used to have full access applies at once.
const legacyId = (await call({ action: "deviceAccess", pin: legacy })).deviceId;
await call({ action: "updateDevice", pin: legacy, ownerPin: "9999", id: legacyId, hidden: ["accounting"] });
assert.equal((await call({ action: "listBankTransactions", pin: legacy })).status, 403);

// Signing the same browser in again is a new device: it starts restricted.
const again = await register();
assert.notEqual(again, staff);
assert.deepEqual((await call({ action: "deviceAccess", pin: again })).hidden, ALL);

console.log("device access tests passed");
