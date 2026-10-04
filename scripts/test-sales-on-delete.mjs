// Monthly sales only count real repairs: deleting a single picked-up repair
// takes its sale back off, restoring it puts the sale back, and "Clear all"
// (an archive) keeps history.
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
const { addTicket, updateTicket, deleteTicket, clearAll, restoreBackup, listMonthlySales, rebuildMonthlySales } = await import("../lib/tickets.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
const now = new Date();
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const month = async () => (await listMonthlySales()).find((m) => m.monthKey === thisMonth) || { totalSales: 0, ticketCount: 0 };
const pickedUp = async (name, cost) => {
  const t = await addTicket({ customerName: name, phone: "8680000000", device: "iPhone 13", issues: "Battery Issue", repairCost: String(cost), amountPaid: "0" });
  await updateTicket({ id: t.id, status: "Picked Up", amountPaid: String(cost) });
  return t;
};

await pickedUp("Real Client", 800);
const mistake = await pickedUp("TEST - delete me", 550);

await test("both pickups are credited to this month", async () => {
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [1350, 2]);
});

await test("deleting a picked-up repair takes its sale off the month", async () => {
  await deleteTicket({ id: mistake.id });
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1]);
});

await test("deleting an unfinished repair doesn't touch sales", async () => {
  const open = await addTicket({ customerName: "Still in shop", phone: "8681111111", device: "Pixel", issues: "Screen", repairCost: "300" });
  await deleteTicket({ id: open.id });
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1]);
});

await test("a full ledger rebuild still leaves the deleted repair out", async () => {
  await rebuildMonthlySales();
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1]);
});

await test("Clear all is an archive — cleared sales stay in the history", async () => {
  const { backup } = await clearAll();
  assert.ok(backup);
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1]);
  await rebuildMonthlySales();
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1], "rebuild keeps cleared sales too");
});

await test("restoring a deleted picked-up repair puts its sale back", async () => {
  // A backup taken while the mistaken repair was still live and picked up.
  await db.query(`INSERT INTO intake_backups (id, created_at, snapshot, count) VALUES ('manual', now(), $1, 1)`,
    [JSON.stringify([{ id: mistake.id, customerName: "TEST - delete me", phone: "8680000000", device: "iPhone 13", issues: "Battery Issue", status: "Picked Up", repairCost: "550", amountPaid: "550" }])]);
  await restoreBackup({ id: "manual" });
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [1350, 2]);
  const [row] = (await db.query(`SELECT sales_reversed, sales_month_key FROM tickets WHERE id = $1`, [mistake.id])).rows;
  assert.deepEqual([row.sales_reversed, row.sales_month_key], [false, thisMonth]);
  // ...and deleting it again reverses it again, exactly once.
  await deleteTicket({ id: mistake.id });
  assert.deepEqual([(await month()).totalSales, (await month()).ticketCount], [800, 1]);
});

console.log(`PASS — ${passed} sales-on-delete scenarios`);
await db.close();
