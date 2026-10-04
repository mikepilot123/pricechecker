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
const { listReminders } = await import("../lib/reminders.js");
const { openDays, collectionToken } = await import("../lib/collection-booking.js");
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
  let code = 200, html = "", location = "";
  const response = { setHeader(k, v) { if (k === "Location") location = v; }, status(c) { code = c; return this; }, json(v) { html = JSON.stringify(v); return this; }, send(v) { html = String(v); return this; } };
  await handler({ method, headers: {}, query, body: form ? new URLSearchParams(form).toString() : undefined }, response);
  return { code, html, location };
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

/* ---- the client picks their collection day ---- */

await test("the email opens with calendar day tiles for the client to pick a collection day", async () => {
  await api({ action: "sendReadyEmail", ticketId: ticket.id, to: "anita@example.com" });
  const mail = dryRunOutbox.at(-1);
  assert.match(mail.html, /Pick your collection day/);
  assert.ok(mail.html.indexOf("Pick your collection day") < mail.html.indexOf("Great news!"), "the day picker comes before the message");
  const links = [...mail.html.matchAll(/href="(https:\/\/repairs\.example\/api\/invoice\?pickup=[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.equal(links.length, 7, "six day tiles plus 'Another day'");
  assert.match(links[0], /&day=\d{4}-\d{2}-\d{2}$/);
  assert.match(mail.text, /Pick your collection day: https:\/\/repairs\.example\/api\/invoice\?pickup=/);
});

const token = collectionToken(ticket.id);
const [day1, day2] = openDays(2);

await test("tapping a day opens a page that books it straight away — the link alone books nothing", async () => {
  const res = await page("GET", { pickup: token, day: day2 });
  assert.equal(res.code, 200);
  assert.match(res.html, /Booking \w+day \d+ \w+…/);
  assert.match(res.html, new RegExp(`name="day" value="${day2}"`));
  assert.match(res.html, /getElementById\("book"\)\.submit\(\)/, "the page posts the booking itself");
  assert.equal((await listAppointments()).length, 0, "email scanners that only fetch the link book nothing");
});

await test("an altered link is refused", async () => {
  const forged = Buffer.from("T-SOMEONE-ELSE").toString("base64url") + "." + token.split(".")[1];
  for (const pickup of [forged, token + "x", "nonsense"]) {
    const res = await page("GET", { pickup });
    assert.equal(res.code, 404);
    assert.match(res.html, /no longer available/);
  }
});

await test("booking makes an appointment, an alert in the app, a note on the repair and an email to the shop", async () => {
  const before = dryRunOutbox.length;
  const res = await page("POST", { pickup: token }, { day: day1 });
  assert.equal(res.code, 303);
  assert.match(res.location, /&booked=1$/);
  const [appt] = await listAppointments();
  assert.equal(appt.id, `COLLECT-${ticket.id}`);
  assert.equal(appt.client, "Anita Singh");
  assert.equal(appt.phone, "8687123456");
  assert.equal(appt.device, "iPhone 13");
  assert.equal(appt.issue, "Collection, Battery Replacement");
  assert.equal(appt.source, "Ready email");
  assert.equal(appt.date, day1);
  assert.equal(appt.time, "08:30");
  assert.match(appt.notes, /any time that day/);
  const notes = await listTicketNotes(ticket.id);
  assert.match(notes[0].note, /^Client chose to collect on \w+day \d+ \w+, any time 8:30 AM–4:30 PM \(from the ready email\)\.$/);
  const reminders = await listReminders();
  const notice = reminders.find((r) => r.kind === "collection");
  assert.ok(notice, "an alert is raised in the app");
  assert.match(notice.title, /^Client coming to collect: Anita Singh — iPhone 13, \w{3} \d+ \w{3}$/);
  assert.ok(new Date(notice.dueAt).getTime() <= Date.now(), "due now, so it pops up straight away");
  assert.equal(notice.done, false);
  assert.equal(notice.priority, "pickup");
  assert.ok(reminders.find((r) => r.id === `APPT:${appt.id}` && /^Client collecting today:/.test(r.title)), "and the day-of reminder");
  assert.equal(dryRunOutbox.length, before + 1);
  const mail = dryRunOutbox.at(-1);
  assert.deepEqual(mail.to, ["jqelectronicstt@gmail.com"], "the shop's own mailbox");
  assert.match(mail.subject, /^Collection booked: Anita Singh — iPhone 13, \w{3} \d+ \w{3}$/);
  assert.match(mail.html, /Add to Google Calendar/);
  assert.match(mail.html, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(mail.html, new RegExp(`dates=${day1.replace(/-/g, "")}T083000%2F${day1.replace(/-/g, "")}T163000`));
  assert.match(mail.html, /TTD \$350\.00/);
  assert.match(mail.text, /Phone: 8687123456/);
});

await test("the confirmation shows the day and an Add to Google Calendar button for the client", async () => {
  const res = await page("GET", { pickup: token, booked: "1" });
  assert.match(res.html, /see you then!/);
  assert.match(res.html, /any time 8:30 AM–4:30 PM/);
  assert.match(res.html, /Add to Google Calendar/);
});

await test("picking again moves the booking and refreshes the alert instead of adding more", async () => {
  await db.query(`UPDATE reminders SET done = TRUE WHERE kind = 'collection'`);
  const shown = await page("GET", { pickup: token });
  assert.match(shown.html, /You're booked for/);
  await page("POST", { pickup: token }, { day: day2 });
  const all = await listAppointments();
  assert.equal(all.length, 1);
  assert.equal(all[0].date, day2);
  const notices = (await listReminders()).filter((r) => r.kind === "collection");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].done, false, "a new pick alerts staff again");
});

await test("a closed or past day is refused, and the booking stays put", async () => {
  const sunday = new Date(`${day1}T12:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
  for (const day of [sunday.toISOString().slice(0, 10), "2020-01-01"]) {
    const shown = await page("GET", { pickup: token, day });
    assert.match(shown.html, /isn(?:'|&#39;)t available any more/);
    const res = await page("POST", { pickup: token }, { day });
    assert.match(res.html, /isn(?:'|&#39;)t available any more/);
  }
  assert.equal((await listAppointments())[0].date, day2);
});

await test("days skip Sundays, and today drops off at 4 PM", () => {
  // Saturday 3 Oct 2026, 5 PM in Trinidad (21:00 UTC).
  assert.deepEqual(openDays(3, new Date("2026-10-03T21:00:00Z")), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  // Friday 2 Oct 2026, 3:10 PM: still today.
  assert.equal(openDays(1, new Date("2026-10-02T19:10:00Z"))[0], "2026-10-02");
});

await test("once the device is picked up, the link says so and books nothing", async () => {
  await updateTicket({ id: ticket.id, status: "Picked Up" });
  const res = await page("GET", { pickup: token, day: day1 });
  assert.match(res.html, /Already collected/);
  await page("POST", { pickup: token }, { day: day1 });
  assert.equal((await listAppointments())[0].date, day2);
});

console.log(`PASS — ${passed} ready-for-collection email scenarios`);
await db.close();
