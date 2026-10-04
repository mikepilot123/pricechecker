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
delete process.env.RESEND_API_KEY;
const { db } = await import("./testing/neon-pglite.mjs");
const { ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addTicket, listTicketNotes, getTicketById } = await import("../lib/tickets.js");
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
  assert.match(draft.message, /The balance due on collection is TTD350\.00/);
  assert.match(draft.message, new RegExp(`ticket #${ticket.id}`));
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
  assert.match(draft.message, /fully paid, so there's nothing to pay/);
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

console.log(`PASS — ${passed} ready-for-collection email scenarios`);
await db.close();
