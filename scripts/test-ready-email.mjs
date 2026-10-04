// "Ready for collection" email: the draft is prefilled from the repair, the
// email goes out from the linked mailbox (captured by EMAIL_DRY_RUN), a note
// is left on the repair, and a typed address is saved to a client without one.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
process.env.EMAIL_DRY_RUN = "1";
process.env.PUBLIC_APP_URL = "https://repairs.example";
delete process.env.RESEND_API_KEY;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addTicket, listTicketNotes, getTicketById, updateTicket } = await import("../lib/tickets.js");
const { listAppointments } = await import("../lib/appointments.js");
const { openDays, timeSlots, collectionToken } = await import("../lib/collection-booking.js");
const { saveSender, dryRunOutbox } = await import("../lib/email.js");
const { default: handler } = await import("../api/invoice.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
async function api(body) {
  let payload;
  const response = { setHeader() {}, status() { return this; }, json(value) { payload = value; return this; }, send() { return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ pin: "0000", ...body }) }, response);
  return payload;
}
// The client's collection-day page: a browser GET, or the page's form POST.
async function page(method, query, form) {
  let code = 200, html = "";
  const response = { setHeader() {}, status(c) { code = c; return this; }, json(v) { html = JSON.stringify(v); return this; }, send(v) { html = String(v); return this; } };
  await handler({ method, headers: {}, query, body: form ? new URLSearchParams(form).toString() : undefined }, response);
  return { code, html };
}

const ticket = await addTicket({ customerName: "Anita Singh", phone: "8687123456", email: "anita@example.com", device: "iPhone 13", issues: "Battery Issue", repairCost: "550", amountPaid: "200", status: "Repaired" });

await test("with no mailbox linked, the draft says so (nothing to send from)", async () => {
  const draft = await api({ action: "readyEmailDraft", ticketId: ticket.id });
  assert.equal(draft.ok, true);
  assert.deepEqual(draft.senders, []);
  const sent = await api({ action: "sendReadyEmail", ticketId: ticket.id, to: "anita@example.com" });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /No email account is linked/);
});

await saveSender({ provider: "gmail", fromEmail: "jqelectronicstt@gmail.com", fromName: "JQ Electronics", host: "smtp.gmail.com", port: 465, password: "app-password" });

await test("the draft is prefilled from the repair", async () => {
  const draft = await api({ action: "readyEmailDraft", ticketId: ticket.id });
  assert.equal(draft.to, "anita@example.com");
  assert.equal(draft.subject, "Your iPhone 13 is ready for collection — JQ Electronics Ltd.");
  assert.match(draft.message, /^Hi Anita,/);
  assert.equal(draft.message, [
    "Hi Anita,",
    "Great news! Your iPhone 13 has been repaired and is ready for collection.",
    "The remaining balance is TTD $350.00, payable by cash or bank transfer upon collection.",
    "Our opening hours are 8:30 AM–4:30 PM, Monday to Saturday.",
    "If you have any questions, feel free to contact us at 482-0451 or 613-7993.",
    "Thank you for choosing JQ Electronics.",
    "Regards,\nJQ Electronics",
  ].join("\n\n"));
  assert.equal(draft.lastSent, null);
});

await test("sending emails the client and leaves a note on the repair", async () => {
  const res = await api({ action: "sendReadyEmail", ticketId: ticket.id, to: "anita@example.com", subject: "Your phone is ready", message: "Hi Anita, it's ready!" });
  assert.equal(res.ok, true, res.error);
  const mail = dryRunOutbox.at(-1);
  assert.deepEqual(mail.to, ["anita@example.com"]);
  assert.equal(mail.subject, "Your phone is ready");
  assert.match(mail.html, /Ready for collection/);
  assert.match(mail.html, /Battery Replacement/, "the repair is named, not the issue");
  assert.match(mail.html, /TTD350\.00/);
  assert.match(mail.html, /Centrapolis Mall/);
  assert.match(mail.text, /Hi Anita, it's ready!/);
  const notes = await listTicketNotes(ticket.id);
  assert.match(notes[0].note, /^Ready-for-collection email sent to anita@example\.com from jqelectronicstt@gmail\.com\.$/);
  const again = await api({ action: "readyEmailDraft", ticketId: ticket.id });
  assert.ok(again.lastSent, "the next draft shows it was already sent");
});

await test("a fully paid repair says there's nothing to pay", async () => {
  const paid = await addTicket({ customerName: "Ravi", phone: "8680000001", device: "Pixel 7", issues: "Charging Port", repairCost: "300", amountPaid: "300", status: "Repaired" });
  const draft = await api({ action: "readyEmailDraft", ticketId: paid.id });
  assert.match(draft.message, /fully paid, so there's nothing to pay upon collection/);
});

await test("an address typed for a client without one is saved to the repair", async () => {
  const noEmail = await addTicket({ customerName: "Nisha", phone: "8680000002", device: "Galaxy A51", issues: "Screen Cracked / Broken", repairCost: "450", amountPaid: "0", status: "Repaired" });
  assert.equal((await api({ action: "readyEmailDraft", ticketId: noEmail.id })).to, "");
  const res = await api({ action: "sendReadyEmail", ticketId: noEmail.id, to: "nisha@example.com", saveEmail: true });
  assert.equal(res.ok, true, res.error);
  assert.equal((await getTicketById(noEmail.id)).email, "nisha@example.com");
});

await test("a bad address is refused before anything is sent", async () => {
  const before = dryRunOutbox.length;
  const res = await api({ action: "sendReadyEmail", ticketId: ticket.id, to: "not-an-email" });
  assert.equal(res.ok, false);
  assert.match(res.error, /isn't a valid To address/);
  assert.equal(dryRunOutbox.length, before);
});

/* ---- the client chooses their collection day ---- */

await test("the email carries day buttons and a link for the client to pick a collection day", async () => {
  await api({ action: "sendReadyEmail", ticketId: ticket.id, to: "anita@example.com" });
  const mail = dryRunOutbox.at(-1);
  assert.match(mail.html, /When will you collect it\?/);
  const links = [...mail.html.matchAll(/href="(https:\/\/repairs\.example\/api\/invoice\?pickup=[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.equal(links.length, 7, "six day buttons plus 'Another day'");
  assert.match(links[0], /&day=\d{4}-\d{2}-\d{2}$/);
  assert.match(mail.text, /Let us know which day you'll collect it: https:\/\/repairs\.example\/api\/invoice\?pickup=/);
});

const token = collectionToken(ticket.id);
const [day1, day2] = openDays(2);

await test("opening the link shows the page but books nothing (email scanners follow links)", async () => {
  const res = await page("GET", { pickup: token, day: day2 });
  assert.equal(res.code, 200);
  assert.match(res.html, /when will you collect your iPhone 13\?/);
  assert.match(res.html, new RegExp(`value="${day2}" checked`), "the day tapped in the email is preselected");
  assert.equal((await listAppointments()).length, 0);
});

await test("an altered link is refused", async () => {
  const forged = Buffer.from("T-SOMEONE-ELSE").toString("base64url") + "." + token.split(".")[1];
  for (const pickup of [forged, token + "x", "nonsense"]) {
    const res = await page("GET", { pickup });
    assert.equal(res.code, 404);
    assert.match(res.html, /no longer available/);
  }
});

await test("confirming books an appointment, with a note on the repair and a reminder", async () => {
  const time = timeSlots(day1).at(-1);
  const res = await page("POST", { pickup: token }, { day: day1, time });
  assert.match(res.html, /see you then!/, res.html);
  const [appt] = await listAppointments();
  assert.equal(appt.id, `COLLECT-${ticket.id}`);
  assert.equal(appt.client, "Anita Singh");
  assert.equal(appt.phone, "8687123456");
  assert.equal(appt.device, "iPhone 13");
  assert.equal(appt.issue, "Collection, Battery Replacement");
  assert.equal(appt.source, "Ready email");
  assert.equal(appt.date, day1);
  assert.equal(appt.time, time);
  assert.equal(appt.status, "scheduled");
  const notes = await listTicketNotes(ticket.id);
  assert.match(notes[0].note, /^Client chose to collect on \w+day \d+ \w+, \d+:\d\d [AP]M \(from the ready email\)\.$/);
  const [reminder] = await db.query(`SELECT * FROM reminders WHERE appointment_id = $1`, [appt.id]).then((r) => r.rows);
  assert.ok(reminder, "the usual appointment reminder is raised");
});

await test("choosing again moves the booking instead of adding a second one", async () => {
  const shown = await page("GET", { pickup: token });
  assert.match(shown.html, /You're booked for/);
  const res = await page("POST", { pickup: token }, { day: day2, time: "any" });
  assert.match(res.html, /any time, 8:30 AM–4:30 PM/);
  const all = await listAppointments();
  assert.equal(all.length, 1);
  assert.equal(all[0].date, day2);
  assert.equal(all[0].time, "08:30");
  assert.match(all[0].notes, /Any time that day/);
});

await test("a closed day or a made-up time is refused, and the booking stays put", async () => {
  const sunday = new Date(`${day1}T12:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
  for (const form of [{ day: sunday.toISOString().slice(0, 10), time: "any" }, { day: "2020-01-01", time: "any" }, { day: day2, time: "03:00" }]) {
    const res = await page("POST", { pickup: token }, form);
    assert.match(res.html, /Please choose one of the (days|times) shown/);
  }
  const [appt] = await listAppointments();
  assert.equal(appt.date, day2);
});

await test("days skip Sundays, and today drops off once the last slot has passed", () => {
  // Saturday 3 Oct 2026, 5 PM in Trinidad (21:00 UTC).
  assert.deepEqual(openDays(3, new Date("2026-10-03T21:00:00Z")), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  // Friday 2 Oct 2026, 3:10 PM: today still has 3:30 and 4:00.
  const now = new Date("2026-10-02T19:10:00Z");
  assert.equal(openDays(1, now)[0], "2026-10-02");
  assert.deepEqual(timeSlots("2026-10-02", now), ["15:30", "16:00"]);
  assert.equal(timeSlots("2026-10-03", now).length, 16);
});

await test("once the device is picked up, the link says so and books nothing", async () => {
  await updateTicket({ id: ticket.id, status: "Picked Up" });
  const res = await page("GET", { pickup: token });
  assert.match(res.html, /Already collected/);
  await page("POST", { pickup: token }, { day: day1, time: "any" });
  assert.equal((await listAppointments())[0].date, day2);
});

console.log(`PASS — ${passed} ready-for-collection email scenarios`);
await db.close();
