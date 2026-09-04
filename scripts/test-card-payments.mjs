// Tests for the card takings ledger (lib/card-payments.js, lib/payouts.js).
//
//   npm test
//
// Runs against a real Postgres — PGlite, the engine compiled to WASM — rather
// than mocks, because everything worth getting wrong here is in the SQL: the
// next-business-day settlement arithmetic, the FILTER aggregates behind the
// owed balance, and the single guarded statement that records a payout. A
// stubbed `sql` would prove none of it.
//
// scripts/testing/hooks.mjs aliases @neondatabase/serverless to a PGlite-backed
// stand-in, so the modules under test are the deployed files, unmodified, and
// the schema is built by the same migrations + ensureSchema() a real deploy runs.
import { register, registerHooks } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Redirect the Neon driver to the PGlite stand-in before anything imports it.
// registerHooks (Node 22.15+) is in-thread and needs no separate hook file;
// register() is the fallback on older runtimes.
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
    },
  });
} else {
  register("./testing/hooks.mjs", import.meta.url);
}
process.env.DATABASE_URL ||= "pglite://memory";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { db } = await import("./testing/neon-pglite.mjs");
const { sql, ensureSchema } = await import("../lib/db.js");
const {
  addCardPayment, updateCardPayment, voidCardPayment,
  listCardPayments, listCollectable, accountSummary,
  computeFee, syncTakingsReminder, TAKINGS_REMINDER_ID,
} = await import("../lib/card-payments.js");
const { addPayout, voidPayout, listPayouts } = await import("../lib/payouts.js");
const { addTicket, updateTicket } = await import("../lib/tickets.js");

// Build the schema, and check every migration file still applies while we're
// here. Order matters and isn't simply "all migrations in sequence":
// migrations/ is not self-contained — `expenses` and `reminders` are only ever
// created by ensureSchema(), while later migrations ALTER them — so a deployed
// instance is really 001, then ensureSchema()'s idempotent top-up, then the
// rest (all of which are IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
const migrations = path.join(root, "migrations");
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
async function apply(file) {
  try {
    await db.exec(readFileSync(path.join(migrations, file), "utf8"));
  } catch (err) {
    console.error(`\nmigration ${file} failed: ${err.message}\n`);
    process.exit(1);
  }
}
await apply(files[0]);
await ensureSchema();
for (const file of files.slice(1)) await apply(file);

let passed = 0;
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failed += 1;
    console.log(`FAIL   ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
  }
}
function section(name) {
  console.log("\n— " + name + " —");
}
/** Render an instant as shop-local wall clock, which is how staff read it. */
async function shopClock(iso) {
  const rows = await sql`SELECT to_char(${iso}::timestamptz AT TIME ZONE 'America/Port_of_Spain', 'Dy YYYY-MM-DD HH24:MI') AS s`;
  return rows[0].s;
}
async function reminderRows() {
  return sql`SELECT title, amount, done FROM reminders WHERE id = ${TAKINGS_REMINDER_ID} AND deleted_at IS NULL`;
}

section("Settlement lands on the next business day");
// 2026-08-31 is a Monday, so this walks a full week including the weekend.
// Times are shop-local (UTC-4); the expectation is shop-local too.
for (const [label, takenAt, expected] of [
  ["Mon afternoon  -> Tue", "2026-08-31T16:10:00-04:00", "Tue 2026-09-01 09:00"],
  ["Thu morning    -> Fri", "2026-09-03T09:00:00-04:00", "Fri 2026-09-04 09:00"],
  ["Fri afternoon  -> Mon", "2026-09-04T16:10:00-04:00", "Mon 2026-09-07 09:00"],
  ["Sat midday     -> Mon", "2026-09-05T11:20:00-04:00", "Mon 2026-09-07 09:00"],
  ["Sun afternoon  -> Mon", "2026-09-06T14:00:00-04:00", "Mon 2026-09-07 09:00"],
  // 11:30pm Friday shop time is 03:30 Saturday UTC — the day has to be worked
  // out in Port of Spain, not UTC, or this settles a day early.
  ["Fri 11:30pm    -> Mon", "2026-09-04T23:30:00-04:00", "Mon 2026-09-07 09:00"],
]) {
  const payment = await addCardPayment({ takenAt, gross: 100, cardType: "debit" });
  check(label, await shopClock(payment.settlesAt), expected);
}
await sql`DELETE FROM card_payments`;

section("Machine fees");
const rates = { debitFee: 0.75, creditFeePct: 4, settlementHour: 9, holdAlertDays: 2, holderName: "" };
check("debit is a flat charge, whatever the size", [computeFee("debit", 450, rates), computeFee("debit", 20, rates)], [0.75, 0.75]);
check("credit is a percentage", computeFee("credit", 450, rates), 18);
check("credit rounds to whole cents", computeFee("credit", 33.33, rates), 1.33);

section("A Friday and Saturday's takings");
const credit450 = await addCardPayment({ takenAt: "2026-09-04T16:10:00-04:00", gross: 450, cardType: "credit", customer: "Anisa", receiptRef: "R-4412" });
const debit180 = await addCardPayment({ takenAt: "2026-09-04T17:02:00-04:00", gross: 180, cardType: "debit", customer: "Ravi" });
const debit95 = await addCardPayment({ takenAt: "2026-09-05T11:20:00-04:00", gross: 95, cardType: "debit", business: "hj" });
check("credit 450 -> fee 18, net 432", [credit450.fee, credit450.net], [18, 432]);
check("debit 180 -> fee 0.75, net 179.25", [debit180.fee, debit180.net], [0.75, 179.25]);
check("all three settle on the same Monday", new Set([credit450, debit180, debit95].map((p) => p.settlesAt)).size, 1);
check("and read as pending until then", [credit450.state, debit180.state, debit95.state], ["pending", "pending", "pending"]);

section("Nothing is collectable before it settles");
check("no payment offered for payout", (await listCollectable()).length, 0);
let summary = await accountSummary();
check("owed 0, pending 705.50", [summary.owed, summary.pending], [0, 705.5]);
check("and no reminder raised yet", (await reminderRows()).length, 0);

section("Monday morning, the money has landed");
await sql`UPDATE card_payments SET settles_at = now() - interval '2 hours'`;
await syncTakingsReminder();
summary = await accountSummary();
check("owed is the full net", summary.owed, 705.5);
check("split by business", [summary.owedByBusiness.jq, summary.owedByBusiness.hj], [611.25, 94.25]);
check("fees paid this month", summary.feesThisMonth, 19.5);
check("three payments ready to collect", (await listCollectable()).length, 3);
const raised = await reminderRows();
check("reminder names the amount", [raised[0].title, Number(raised[0].amount), raised[0].done], ["Collect $705.50 card takings", 705.5, false]);

section("Recording the payout");
const payout = await addPayout({
  paidAt: "2026-09-07T09:30:00-04:00", method: "Bank transfer", reference: "TT88213",
  paymentIds: [credit450.id, debit180.id, debit95.id],
});
check("amount is computed from the payments, not the form", payout.amount, 705.5);
check("it cleared all three", payout.paymentCount, 3);
summary = await accountSummary();
check("owed is back to zero", summary.owed, 0);
check("collected this month", summary.collectedThisMonth, 705.5);
check("reminder retires itself at a zero balance", (await reminderRows()).length, 0);
check("payments read as collected", (await listCardPayments({})).map((p) => p.state), ["collected", "collected", "collected"]);

section("Guards");
let error = null;
try {
  await addPayout({ paymentIds: [credit450.id] });
} catch (err) {
  error = err.message;
}
check("the same money can't be paid out twice", /can no longer be collected/.test(error || ""), true);
check("and the refused payout wrote no row", (await listPayouts()).length, 1);
error = null;
try {
  await updateCardPayment({ id: credit450.id, gross: 999 });
} catch (err) {
  error = err.message;
}
check("a collected payment can't be edited underneath its payout", /Void the payout first/.test(error || ""), true);
error = null;
try {
  await addCardPayment({ gross: 10, cardType: "debit", fee: 25 });
} catch (err) {
  error = err.message;
}
check("the fee can't exceed the takings", /Fee cannot be more/.test(error || ""), true);

section("Voiding a payout releases its payments");
const voided = await voidPayout({ id: payout.id, reason: "Transfer bounced" });
check("payout is marked void, not deleted", [!!voided.voidedAt, voided.voidReason], [true, "Transfer bounced"]);
summary = await accountSummary();
check("the balance comes back", summary.owed, 705.5);
check("payments are settled again", (await listCardPayments({})).map((p) => p.state), ["settled", "settled", "settled"]);
check("and the reminder reopens", (await reminderRows()).length, 1);

section("Voiding a payment (a refund)");
await voidCardPayment({ id: debit95.id, reason: "Customer refunded" });
summary = await accountSummary();
check("owed drops by that payment's net", summary.owed, 611.25);
check("the row leaves the day-to-day list", (await listCardPayments({})).length, 2);
check("but history still has it", (await listCardPayments({ includeVoided: true })).length, 3);

section("Partial payout");
const second = await addPayout({ paidAt: "2026-09-08T09:00:00-04:00", method: "Bank transfer", paymentIds: [debit180.id] });
check("covers only what was ticked", second.amount, 179.25);
summary = await accountSummary();
check("the rest stays owed", summary.owed, 432);

section("A repair paid on the card machine");
// The ticket is the only place the amount is typed; the ledger row has to
// follow it, or the two quietly disagree about what the shop is owed.
const beforeTickets = (await listCardPayments({ includeVoided: true })).length;
const ticket = await addTicket({
  customerName: "Shivani Baksh", device: "iPhone 13", issues: "Screen",
  repairCost: 900, amountPaid: 900, paymentMethod: "card", cardType: "credit",
});
check("the ticket records how it was paid", [ticket.paymentMethod, ticket.cardType], ["card", "credit"]);
check("and it created exactly one ledger row", (await listCardPayments({ includeVoided: true })).length, beforeTickets + 1);
let linked = (await listCardPayments({ includeVoided: true })).find((p) => p.id === ticket.cardPaymentId);
check("with the repair's amount and a 4% fee", [linked.gross, linked.fee, linked.net], [900, 36, 864]);
check("linked back to the ticket", linked.ticketId, ticket.id);

const corrected = await updateTicket({ id: ticket.id, amountPaid: 850 });
linked = (await listCardPayments({ includeVoided: true })).find((p) => p.id === corrected.cardPaymentId);
check("correcting the amount follows through to the ledger", [linked.gross, linked.fee, linked.net], [850, 34, 816]);

const switched = await updateTicket({ id: ticket.id, paymentMethod: "cash" });
const wasLinked = (await listCardPayments({ includeVoided: true })).find((p) => p.id === ticket.cardPaymentId);
check("switching to cash voids the ledger row", wasLinked.state, "void");
check("and unlinks it from the ticket", [switched.paymentMethod, switched.cardPaymentId], ["cash", ""]);

const backToCard = await updateTicket({ id: ticket.id, paymentMethod: "card", cardType: "debit" });
linked = (await listCardPayments({ includeVoided: true })).find((p) => p.id === backToCard.cardPaymentId);
check("switching back opens a fresh row, not the voided one", [linked.state !== "void", linked.fee], [true, 0.75]);

// An ordinary status change must not disturb the ledger.
const beforeStatus = (await listCardPayments({ includeVoided: true })).length;
await updateTicket({ id: ticket.id, status: "Ready for Pickup" });
check("a status change leaves the ledger alone", (await listCardPayments({ includeVoided: true })).length, beforeStatus);

section("The invariant");
// Every live payment is in exactly one of three buckets, and they have to add
// up to the whole ledger. This is the property the entire feature rests on: if
// it ever fails, some money has been counted twice or lost.
const [totals] = await sql`
  SELECT COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at <= now()), 0) AS owed,
         COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NULL AND settles_at > now()), 0) AS pending,
         COALESCE(SUM(gross - fee) FILTER (WHERE payout_id IS NOT NULL), 0) AS collected,
         COALESCE(SUM(gross - fee), 0) AS total
  FROM card_payments WHERE deleted_at IS NULL AND voided_at IS NULL
`;
check(
  "owed + pending + collected = the whole live ledger",
  Math.round((Number(totals.owed) + Number(totals.pending) + Number(totals.collected)) * 100) / 100,
  Number(totals.total)
);
const summaryNow = await accountSummary();
check("and the summary the app renders agrees with the database", [summaryNow.owed, summaryNow.pending], [Number(totals.owed), Number(totals.pending)]);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
