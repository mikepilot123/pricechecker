// A client booking their collection day (from the ready email) is flagged as
// new for staff — the number on the Appointments nav item — until someone
// opens Appointments. Moving the day makes it new again. Runs the real
// api/intake.js handler against an in-memory Postgres.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { default: handler } = await import("../api/intake.js");
const { bookCollectionAppointment } = await import("../lib/appointments.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  assert.equal(payload.ok, true, payload.error);
  return payload;
}
const book = (ticketId, date, time = "10:00") => bookCollectionAppointment({
  ticketId, client: "Anita Singh", phone: "8687123456", device: "iPhone 13", issue: "Collection", date, time, source: "Ready email",
});
const newIds = async () => (await api({ action: "listNewClientBookings" })).appointments.map((a) => a.id);

await test("an appointment staff make themselves is never \"new\"", async () => {
  await api({ action: "addAppointment", client: "Walk-in", date: "2026-12-01", time: "09:00" });
  assert.deepEqual(await newIds(), []);
  const { appointments } = await api({ action: "listAppointments" });
  assert.equal(appointments[0].clientBooked, false);
  assert.equal(appointments[0].isNew, false);
});

await test("a client's collection booking is new until staff see it", async () => {
  const appt = await book("T1", "2026-12-02");
  assert.equal(appt.clientBooked, true);
  assert.equal(appt.isNew, true);
  assert.deepEqual(await newIds(), ["COLLECT-T1"]);
  const { marked } = await api({ action: "markAppointmentsSeen", ids: ["COLLECT-T1"] });
  assert.equal(marked, 1);
  assert.deepEqual(await newIds(), []);
  const { appointments } = await api({ action: "listAppointments" });
  const seen = appointments.find((a) => a.id === "COLLECT-T1");
  assert.equal(seen.clientBooked, true, "still tagged as client-booked");
  assert.equal(seen.isNew, false);
});

await test("a client moving their day makes it new again", async () => {
  await book("T1", "2026-12-03");
  assert.deepEqual(await newIds(), ["COLLECT-T1"]);
});

await test("marking with no ids clears every new booking", async () => {
  await book("T2", "2026-12-04");
  assert.equal((await newIds()).length, 2);
  await api({ action: "markAppointmentsSeen" });
  assert.deepEqual(await newIds(), []);
});

await test("a deleted booking doesn't count", async () => {
  await book("T3", "2026-12-05");
  await api({ action: "deleteAppointment", id: "COLLECT-T3" });
  assert.deepEqual(await newIds(), []);
});

console.log(`All ${passed} new collection booking tests passed`);
