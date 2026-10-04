// Zoho Books sync against an in-memory fake of the Zoho API: nothing happens
// until connected, only new records go over, payments follow Payment Made
// with the right method, expenses land in matching accounts, and failures
// are kept for retry instead of breaking the save.
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

/* ---- Fake Zoho ----------------------------------------------------------- */
const zoho = {
  calls: [], contacts: [], invoices: new Map(), payments: [], expenses: new Map(), voided: [], seq: 1,
  down: false, takenNumbers: new Set(),
  accounts: [
    { account_id: "A-PETTY", account_name: "Petty Cash", account_type: "cash" },
    { account_id: "A-UNDEP", account_name: "Undeposited Funds", account_type: "cash" },
    { account_id: "A-BANK", account_name: "Republic Bank", account_type: "bank" },
    { account_id: "A-COGS", account_name: "Cost of Goods Sold", account_type: "cost_of_goods_sold" },
    { account_id: "A-RENT", account_name: "Rent Expense", account_type: "expense" },
    { account_id: "A-ADS", account_name: "Advertising And Marketing", account_type: "expense" },
    { account_id: "A-OTHER", account_name: "Other Expenses", account_type: "expense" },
  ],
};
const ok = (extra) => new Response(JSON.stringify({ code: 0, message: "success", ...extra }), { status: 200 });
const fail = (message, code = 1001) => new Response(JSON.stringify({ code, message }), { status: 400 });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || "GET";
  const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
  zoho.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  // Zoho must never be asked to contact a client.
  assert.ok(!/\/email|\/remind(?!er\/disable)|\/submit|portal/i.test(u.pathname.replace("/paymentreminder/disable", "")), `nothing may email or invite: ${method} ${u.pathname}`);
  assert.notEqual(u.searchParams.get("send"), "true", "never create with send=true");
  assert.ok(!body?.contact_persons, "no contact persons — Zoho only thanks/emails those");
  if (u.hostname === "accounts.zoho.com") {
    const p = new URLSearchParams(init.body);
    if (p.get("grant_type") === "authorization_code" && p.get("code") !== "GOOD-CODE") return new Response(JSON.stringify({ error: "invalid_code" }));
    return new Response(JSON.stringify({ access_token: "AT-" + zoho.seq++, refresh_token: "RT", expires_in: 3600, api_domain: "https://www.zohoapis.com" }));
  }
  if (zoho.down) return fail("Service unavailable", 503);
  assert.equal(u.searchParams.get("organization_id"), "60012345", "every call names the organisation");
  assert.match(init.headers.Authorization, /^Zoho-oauthtoken AT-/);
  const path = u.pathname.replace("/books/v3", "");
  let m;
  if (path === "/organizations/60012345") return ok({ organization: { name: "JQ Electronics" } });
  if (path === "/chartofaccounts") return ok({ chartofaccounts: zoho.accounts });
  if (path === "/contacts" && method === "GET") {
    const q = Object.fromEntries(u.searchParams);
    const person = (c) => c.contact_persons?.[0] || {};
    const hit = zoho.contacts.find((c) => (q.email && person(c).email === q.email) || (q.phone && person(c).phone === q.phone) || (q.contact_name && c.contact_name === q.contact_name));
    return ok({ contacts: hit ? [hit] : [] });
  }
  if ((m = path.match(/^\/(contacts|invoices)\/([^/]+)\/paymentreminder\/disable$/))) {
    const target = m[1] === "contacts" ? zoho.contacts.find((c) => c.contact_id === m[2]) : zoho.invoices.get(m[2]);
    if (!target) return fail("Does not exist.", 1002);
    target.remindersOff = true;
    return ok({});
  }
  if ((m = path.match(/^\/invoices\/([^/]+)\/payments$/))) {
    if (!zoho.invoices.has(m[1])) return fail("Invoice does not exist.", 1002);
    return ok({ payments: zoho.payments.filter((p) => p.invoices[0].invoice_id === m[1]).map((p) => ({ payment_id: p.payment_id, amount: p.amount, payment_mode: p.payment_mode, date: p.date, is_single_invoice_payment: true })) });
  }
  if ((m = path.match(/^\/customerpayments\/([^/]+)$/)) && method === "DELETE") {
    zoho.payments = zoho.payments.filter((p) => p.payment_id !== m[1]);
    return ok({});
  }
  if ((m = path.match(/^\/invoices\/([^/]+)$/)) && method === "DELETE") {
    if (!zoho.invoices.has(m[1])) return fail("Invoice does not exist.", 1002);
    if (zoho.payments.some((p) => p.invoices[0].invoice_id === m[1])) return fail("Invoices with payments cannot be deleted.", 1037);
    zoho.invoices.delete(m[1]);
    return ok({});
  }
  if (path === "/contacts" && method === "POST") {
    if (zoho.contacts.some((c) => c.contact_name === body.contact_name)) return fail("The customer already exists.", 3062);
    const contact = { contact_id: "C" + zoho.seq++, ...body };
    zoho.contacts.push(contact);
    return ok({ contact });
  }
  if (path === "/invoices" && method === "POST") {
    if (!zoho.contacts.some((c) => c.contact_id === body.customer_id)) return fail("Customer does not exist.", 1002);
    if (body.invoice_number && zoho.takenNumbers.has(body.invoice_number)) return fail("Invoice number already exists.", 1001);
    const invoice = { invoice_id: "Z" + zoho.seq++, status: "draft", invoice_number: body.invoice_number || "ZINV-" + zoho.seq, ...body };
    zoho.invoices.set(invoice.invoice_id, invoice);
    return ok({ invoice });
  }
  if ((m = path.match(/^\/invoices\/([^/]+)\/status\/(sent|void)$/))) {
    if (!zoho.invoices.has(m[1])) return fail("Invoice does not exist.", 1002);
    zoho.invoices.get(m[1]).status = m[2] === "sent" ? "sent" : "void";
    if (m[2] === "void") zoho.voided.push(m[1]);
    return ok({});
  }
  if ((m = path.match(/^\/invoices\/([^/]+)$/)) && method === "PUT") {
    Object.assign(zoho.invoices.get(m[1]), body);
    return ok({ invoice: zoho.invoices.get(m[1]) });
  }
  if (path === "/customerpayments" && method === "POST") {
    assert.notEqual(zoho.invoices.get(body.invoices[0].invoice_id).status, "draft", "payments only go on a sent invoice");
    const payment = { payment_id: "P" + zoho.seq++, ...body };
    zoho.payments.push(payment);
    return ok({ payment });
  }
  if (path === "/expenses" && method === "POST") {
    const expense = { expense_id: "X" + zoho.seq++, ...body };
    zoho.expenses.set(expense.expense_id, expense);
    return ok({ expense });
  }
  if ((m = path.match(/^\/expenses\/([^/]+)$/))) {
    if (method === "PUT") { Object.assign(zoho.expenses.get(m[1]), body); return ok({}); }
    if (method === "DELETE") { zoho.expenses.delete(m[1]); return ok({}); }
  }
  throw new Error(`Fake Zoho has no route for ${method} ${path}`);
};

const { createInvoice, updateInvoice, deleteInvoice } = await import("../lib/invoices.js");
const { addExpense, updateExpense, deleteExpense } = await import("../lib/expenses.js");
const { connectZoho, zohoStatus, retryZohoSync, disconnectZoho } = await import("../lib/zoho.js");
const { addTicket, updateTicket } = await import("../lib/tickets.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }
const invoiceInput = (extra = {}) => ({
  customerName: "Anita Singh", phone: "868 712 3456", email: "anita@example.com",
  items: [{ description: "iPhone 13 Battery Replacement", detail: "", qty: 1, rate: 550 }],
  paymentMade: 0, ...extra,
});

let oldInvoice, oldExpense;
await test("nothing reaches Zoho before it's connected", async () => {
  oldInvoice = await createInvoice(invoiceInput());
  oldExpense = await addExpense({ date: "2026-10-01", category: "Rent", amount: 3000 });
  assert.equal(zoho.calls.length, 0);
  assert.equal((await zohoStatus()).connected, false);
});

await test("connecting rejects a bad code, then saves a good one", async () => {
  const form = { clientId: "1000.ABC", clientSecret: "shh", organizationId: "60012345", dataCenter: "com" };
  await assert.rejects(connectZoho({ ...form, code: "OLD" }), /expired or was already used/);
  const status = await connectZoho({ ...form, code: "GOOD-CODE" });
  assert.deepEqual([status.connected, status.organizationName], [true, "JQ Electronics"]);
  const [row] = (await db.query(`SELECT value FROM app_settings WHERE key = 'zoho'`)).rows;
  assert.ok(!JSON.stringify(row.value).includes("shh"), "the client secret is stored encrypted");
  assert.ok(!JSON.stringify(row.value).includes('"RT"'), "the refresh token is stored encrypted");
});

await test("records from before the connection are never sent, even when edited", async () => {
  // Backdate them to before the connection, as they would be in real life.
  await db.query(`UPDATE custom_invoices SET created_at = now() - interval '1 day' WHERE id = $1`, [oldInvoice.id]);
  await db.query(`UPDATE expenses SET created_at = now() - interval '1 day' WHERE id = $1`, [oldExpense.id]);
  const before = zoho.calls.length;
  await updateInvoice(oldInvoice.id, { paymentMade: 550 });
  await updateExpense({ id: oldExpense.id, amount: 3100 });
  assert.equal(zoho.calls.length, before);
  assert.equal(zoho.invoices.size, 0);
});

let invoice, ticket;
await test("a new invoice is created in Zoho with its customer, number and lines", async () => {
  ticket = await addTicket({ customerName: "Anita Singh", phone: "868 712 3456", device: "iPhone 13", issues: "Battery Issue", repairCost: "550", amountPaid: "200", paymentMethod: "cash" });
  invoice = await createInvoice(invoiceInput({ ticketIds: [ticket.id], paymentMade: 200 }));
  assert.equal(zoho.invoices.size, 1);
  const [z] = zoho.invoices.values();
  assert.equal(z.invoice_number, invoice.number);
  assert.equal(z.status, "sent");
  assert.deepEqual(z.line_items, [{ name: "iPhone 13 Battery Replacement", description: "", rate: 550, quantity: 1 }]);
  assert.equal(zoho.contacts.length, 1);
  assert.equal(z.customer_id, zoho.contacts[0].contact_id);
  const c = zoho.contacts[0];
  assert.deepEqual([c.email, c.phone, c.contact_persons], [undefined, undefined, undefined], "Zoho gets no address to contact the client on");
  assert.equal(c.notes, "Phone: 868 712 3456 · Email: anita@example.com", "the details are kept for the record");
  assert.equal(c.remindersOff, true, "payment reminders are off for the customer");
  assert.equal(z.remindersOff, true, "and for the invoice");
  assert.equal(zoho.payments.length, 1, "the check-in payment goes with it");
  assert.deepEqual([zoho.payments[0].amount, zoho.payments[0].payment_mode, zoho.payments[0].account_id], [200, "cash", "A-PETTY"]);
});

await test("re-saving with nothing changed sends nothing", async () => {
  const before = zoho.calls.length;
  await updateInvoice(invoice.id, {});
  assert.equal(zoho.calls.length, before);
});

await test("pickup by bank transfer records just the balance, to the bank", async () => {
  await updateTicket({ id: ticket.id, status: "Picked Up", amountPaid: "550", paymentMethod: "transfer" });
  await updateInvoice(invoice.id, { paymentMade: 550 });
  assert.equal(zoho.payments.length, 2);
  assert.deepEqual([zoho.payments[1].amount, zoho.payments[1].payment_mode, zoho.payments[1].account_id], [350, "banktransfer", "A-BANK"]);
});

await test("editing the invoice updates the same Zoho invoice", async () => {
  await updateInvoice(invoice.id, { notes: "Thanks!" });
  assert.equal(zoho.invoices.size, 1);
  assert.equal([...zoho.invoices.values()][0].notes, "Thanks!");
});

await test("a second invoice for the same client reuses their Zoho contact", async () => {
  await createInvoice(invoiceInput());
  assert.equal(zoho.contacts.length, 1);
  assert.equal(zoho.invoices.size, 2);
});

await test("an invoice number already used in Zoho falls back to Zoho's numbering", async () => {
  const next = `INV-${String(Number(invoice.number.slice(4)) + 2).padStart(6, "0")}`;
  zoho.takenNumbers.add(next);
  const inv = await createInvoice(invoiceInput({ customerName: "Ravi", phone: "", email: "" }));
  assert.equal(inv.number, next);
  const z = [...zoho.invoices.values()].at(-1);
  assert.ok(!z.invoice_number.startsWith("INV-"));
  assert.match(z.reference_number, new RegExp(`App ${next}`));
});

await test("an existing Zoho customer with an email is reused, with reminders switched off", async () => {
  zoho.contacts.push({ contact_id: "C-OLD", contact_name: "Breanna Quashie", contact_persons: [{ email: "breanna@example.com" }] });
  await createInvoice(invoiceInput({ customerName: "Breanna Quashie", phone: "", email: "breanna@example.com" }));
  assert.equal([...zoho.invoices.values()].at(-1).customer_id, "C-OLD");
  assert.equal(zoho.contacts.find((c) => c.contact_id === "C-OLD").remindersOff, true);
});

await test("lowering Payment Made takes the latest Zoho payment back off", async () => {
  const t = await addTicket({ customerName: "Lowered", phone: "8680001111", device: "Pixel 7", issues: "Battery Issue", repairCost: "550", amountPaid: "200", paymentMethod: "cash" });
  const inv = await createInvoice(invoiceInput({ customerName: "Lowered", phone: "8680001111", email: "", ticketIds: [t.id], paymentMade: 200 }));
  const zid = [...zoho.invoices.values()].at(-1).invoice_id;
  await updateTicket({ id: t.id, amountPaid: "550", paymentMethod: "transfer" });
  await updateInvoice(inv.id, { paymentMade: 550 });
  await updateInvoice(inv.id, { paymentMade: 500 }); // corrected down by 50
  const mine = zoho.payments.filter((p) => p.invoices[0].invoice_id === zid).map((p) => [p.amount, p.payment_mode]);
  assert.deepEqual(mine, [[200, "cash"], [300, "banktransfer"]], "the 350 transfer became 300, the cash untouched");
  assert.equal((await zohoStatus()).issues.length, 0);
});

await test("deleting an invoice deletes it in Zoho, payments first", async () => {
  const inv = await createInvoice(invoiceInput({ customerName: "To delete", phone: "", email: "", paymentMade: 100 }));
  const zid = [...zoho.invoices.values()].at(-1).invoice_id;
  assert.ok(zoho.payments.some((p) => p.invoices[0].invoice_id === zid));
  await deleteInvoice(inv.id);
  assert.equal(zoho.invoices.has(zid), false, "the invoice is gone from Zoho");
  assert.equal(zoho.payments.some((p) => p.invoices[0].invoice_id === zid), false, "and so are its payments");
  assert.ok(!zoho.voided.includes(zid), "deleted, not just voided");
});

await test("an invoice already deleted in Zoho counts as deleted, not a problem", async () => {
  const inv = await createInvoice(invoiceInput({ customerName: "Gone already", phone: "", email: "" }));
  const zid = [...zoho.invoices.values()].at(-1).invoice_id;
  zoho.invoices.delete(zid); // removed by hand in Zoho
  await deleteInvoice(inv.id);
  assert.equal((await zohoStatus()).issues.length, 0);
});

await test("a customer deleted in Zoho is recreated on their next invoice", async () => {
  const gone = zoho.contacts.findIndex((c) => c.contact_name === "Anita Singh");
  zoho.contacts.splice(gone, 1);
  await createInvoice(invoiceInput());
  const z = [...zoho.invoices.values()].at(-1);
  const anita = zoho.contacts.find((c) => c.contact_name === "Anita Singh");
  assert.ok(anita, "recreated");
  assert.equal(z.customer_id, anita.contact_id);
});

let expense;
await test("expenses are filed under the matching Zoho account, paid from petty cash", async () => {
  expense = await addExpense({ date: "2026-10-04", category: "Parts", vendor: "Mobilesentrix", amount: 964.32, notes: "Screens" });
  const [z] = zoho.expenses.values();
  assert.deepEqual([z.account_id, z.amount, z.paid_through_account_id, z.date, z.description], ["A-COGS", 964.32, "A-PETTY", "2026-10-04", "Mobilesentrix — Screens"]);
  await addExpense({ date: "2026-10-04", category: "Marketing", vendor: "Meta Ads", amount: 231 });
  assert.equal([...zoho.expenses.values()].at(-1).account_id, "A-ADS");
  await addExpense({ date: "2026-10-04", category: "Tools", amount: 40 });
  assert.equal([...zoho.expenses.values()].at(-1).account_id, "A-OTHER", "no tools account → Other Expenses");
});

await test("a bank withdrawal for rent is filed as Rent, paid from the bank", async () => {
  await addExpense({ date: "2026-10-04", category: "Bank withdrawal", vendor: "Rent", amount: 3000 });
  const z = [...zoho.expenses.values()].at(-1);
  assert.deepEqual([z.account_id, z.paid_through_account_id], ["A-RENT", "A-BANK"]);
});

await test("editing and deleting an expense follows through to Zoho", async () => {
  const zid = [...zoho.expenses.keys()][0];
  await updateExpense({ id: expense.id, amount: 970 });
  assert.equal(zoho.expenses.get(zid).amount, 970);
  await deleteExpense({ id: expense.id });
  assert.equal(zoho.expenses.has(zid), false);
});

await test("when Zoho is down the save still works and the failure is kept for retry", async () => {
  zoho.down = true;
  const saved = await addExpense({ date: "2026-10-04", category: "Utilities", amount: 120 });
  assert.ok(saved.id, "the expense saved in the app");
  let status = await zohoStatus();
  assert.equal(status.expenses.failed, 1);
  assert.match(status.issues[0].error, /Service unavailable/);
  zoho.down = false;
  const result = await retryZohoSync();
  assert.deepEqual([result.tried, result.synced], [1, 1]);
  status = await zohoStatus();
  assert.equal(status.expenses.failed, 0);
});

await test("disconnecting stops all syncing", async () => {
  await disconnectZoho();
  const before = zoho.calls.length;
  await addExpense({ date: "2026-10-04", category: "Rent", amount: 10 });
  assert.equal(zoho.calls.length, before);
});

console.log(`PASS — ${passed} Zoho Books sync scenarios`);
await db.close();
