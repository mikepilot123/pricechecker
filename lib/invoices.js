import { randomUUID } from "node:crypto";
import { sql } from "./db.js";

const CURRENCY = process.env.INVOICE_CURRENCY || "TTD";
const BUSINESS_NAME = process.env.INVOICE_BUSINESS_NAME || "JQ Electronics";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const INVOICE_FROM_EMAIL = process.env.INVOICE_FROM_EMAIL || "";
const SHOP_TIME_ZONE = "America/Port_of_Spain";

// The "from" block printed at the top of every invoice (and the PDF the app
// builds from it). Mirrors the shop's Zoho invoices.
export const INVOICE_BUSINESS = {
  name: process.env.INVOICE_LEGAL_NAME || "JQ Electronics Ltd.",
  addressLines: ["Centrapolis Mall", "80 Ramsaran Street", "Chaguanas", "Trinidad and Tobago"],
  email: process.env.INVOICE_BUSINESS_EMAIL || "jqelectronicstt@gmail.com",
};

// Default Notes on a new invoice — the shop's standing thank-you and
// warranty policy, as printed on its Zoho invoices. Editable per invoice.
export const DEFAULT_INVOICE_NOTES = `Thanks for choosing JQ Electronics!

60-Day Repair Warranty Policy

We provide a 60-day warranty on repairs completed on non-water damaged devices using parts supplied by us. This warranty covers manufacturing defects related specifically to the repair performed.

Please note:

* Devices with water or liquid damage are not covered by warranty.
* Parts supplied by the customer or another repair provider are not covered.
* When a device is received by us and isn't powering on, we would not be able to complete a full diagnostic before the repair. We are therefore not responsible for unrelated or additional issues that become noticeable once the device is powered on.
* The warranty does not cover issues unrelated to the original repair.
* The warranty will be void if the device is dropped, physically damaged, exposed to liquid, tampered with, or repaired by another person or repair provider during the warranty period.
* Motherboard repairs are non-refundable.

Please retain your receipt for warranty service. If your device has any issues, it must be brought in DURING the warranty period.

Please note that customers are required to collect their device within 90 days of being notified that it is ready for collection, whether the device has been repaired, deemed unrepairable, or is awaiting collection following diagnostics.

Due to limited storage capacity, JQ Electronics cannot hold devices beyond 90 days. Devices that remain uncollected after the 90-day period with no communication or feedback for collection will be considered abandoned and otherwise handled at our discretion.`;

/* ---- Invoice shape ------------------------------------------------------
   Everything editable lives in `payload` (JSONB):
     number, invoiceDate, dueDate, terms,
     billTo { name, phone, email },
     items [{ description, detail, qty, rate }],
     paymentMade, notes, ticketIds[]
   The flat columns (customer_name, repair_cost, amount_paid, …) are kept in
   step so older code and reports that read them still see sensible values.
   Invoices created before line items existed are upgraded on read. */

export async function createInvoice(input) {
  const [{ n }] = await sql`SELECT nextval('invoice_number_seq') AS n`;
  const today = shopToday();
  const draft = {
    number: text(input.number) || formatInvoiceNumber(n),
    invoiceDate: dateOnly(input.invoiceDate) || today,
    dueDate: dateOnly(input.dueDate) || dateOnly(input.invoiceDate) || today,
    terms: text(input.terms) || "Due on Receipt",
    billTo: {
      name: text(input.billTo?.name || input.customerName || input.client),
      phone: text(input.billTo?.phone || input.phone),
      email: text(input.billTo?.email || input.email),
    },
    items: Array.isArray(input.items) && input.items.length ? input.items : legacyItems(input),
    paymentMade: input.paymentMade ?? input.amountPaid,
    notes: input.notes == null || input.useDefaultNotes ? DEFAULT_INVOICE_NOTES : String(input.notes),
    ticketIds: Array.isArray(input.ticketIds) ? input.ticketIds : [input.ticketId].filter(Boolean),
    // Legacy single-device fields, kept for the flat columns.
    device: text(input.device),
    issues: text(input.issues || input.issue),
    status: text(input.status || "Received"),
  };
  const invoice = normalizeInvoice(draft);
  const id = "INV-" + Date.now().toString(36).toUpperCase() + "-" + randomUUID().slice(0, 4).toUpperCase();
  const token = randomUUID();
  const rows = await sql`
    INSERT INTO custom_invoices (id, token, ticket_id, customer_name, email, phone, device, issues, status, notes, repair_cost, amount_paid, currency, payload)
    VALUES (${id}, ${token}, ${invoice.ticketIds[0] || ""}, ${invoice.billTo.name}, ${invoice.billTo.email}, ${invoice.billTo.phone}, ${draft.device}, ${draft.issues}, ${draft.status}, ${invoice.notes}, ${invoice.total}, ${invoice.paymentMade}, ${CURRENCY}, ${JSON.stringify(invoice)}::jsonb)
    RETURNING *
  `;
  return rowToInvoice(rows[0]);
}

export async function updateInvoice(id, changes) {
  const key = text(id);
  if (!key) throw new Error("Invoice ID is required");
  const rows = await sql`SELECT * FROM custom_invoices WHERE id = ${key} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Invoice not found");
  const current = rowToInvoice(rows[0]);
  const next = normalizeInvoice({
    ...current,
    ...pick(changes || {}, ["number", "invoiceDate", "dueDate", "terms", "billTo", "items", "paymentMade", "notes"]),
    ticketIds: current.ticketIds,
  });
  const updated = await sql`
    UPDATE custom_invoices
    SET customer_name = ${next.billTo.name},
        email = ${next.billTo.email},
        phone = ${next.billTo.phone},
        notes = ${next.notes},
        repair_cost = ${next.total},
        amount_paid = ${next.paymentMade},
        payload = ${JSON.stringify({ ...next, updatedAt: new Date().toISOString() })}::jsonb
    WHERE id = ${key}
    RETURNING *
  `;
  return rowToInvoice(updated[0]);
}

export async function getInvoiceByToken(token) {
  const key = String(token || "").trim();
  if (!key) throw new Error("Invoice token is required");
  const rows = await sql`SELECT * FROM custom_invoices WHERE token = ${key} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Invoice not found");
  return rowToInvoice(rows[0]);
}

export async function getInvoiceById(id) {
  const rows = await sql`SELECT * FROM custom_invoices WHERE id = ${text(id)} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Invoice not found");
  return rowToInvoice(rows[0]);
}

/** Soft delete: hidden everywhere (list, repair lookup, customer link) but
 *  kept in the table so a mistaken delete can still be recovered. */
export async function deleteInvoice(id) {
  const rows = await sql`
    UPDATE custom_invoices SET deleted_at = now()
    WHERE id = ${text(id)} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) throw new Error("Invoice not found");
  return { id: rows[0].id };
}

/** Every invoice, newest first — powers the Invoices tab. */
export async function listInvoices() {
  const rows = await sql`SELECT * FROM custom_invoices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 2000`;
  return rows.map(rowToInvoice);
}

/** Latest invoice that includes this repair ticket, or null. */
export async function getInvoiceForTicket(ticketId) {
  const key = text(ticketId);
  if (!key) throw new Error("Ticket ID is required");
  const rows = await sql`
    SELECT * FROM custom_invoices
    WHERE deleted_at IS NULL
      AND (ticket_id = ${key} OR payload->'ticketIds' @> ${JSON.stringify([key])}::jsonb)
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows.length ? rowToInvoice(rows[0]) : null;
}

export async function sendInvoiceEmail(invoice, invoiceUrl) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  if (!INVOICE_FROM_EMAIL) throw new Error("INVOICE_FROM_EMAIL is not set");
  if (!invoice.billTo.email) throw new Error("Customer email is required");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: INVOICE_FROM_EMAIL,
      to: [invoice.billTo.email],
      subject: `Your repair invoice - ${invoice.number}`,
      html: invoiceEmailHtml(invoice, invoiceUrl),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("Invoice email failed: " + JSON.stringify(data));
  await sql`UPDATE custom_invoices SET emailed_at = now() WHERE id = ${invoice.id}`;
  return data;
}

export function invoiceWhatsAppUrl(invoice, invoiceUrl) {
  const phone = whatsAppNumber(invoice.billTo.phone);
  if (!phone) return "";
  const text = `Hi ${invoice.billTo.name}, your ${BUSINESS_NAME} repair invoice ${invoice.number} is ${invoice.currency} ${money(invoice.total)} (balance due ${invoice.currency} ${money(invoice.balanceDue)}).\n${invoiceUrl}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

// Customer-facing page behind the invoice link. Laid out like the shop's
// Zoho invoices (and the PDF the app generates), with a print/save button.
export function invoiceHtml(invoice) {
  const b = invoice.business;
  const cur = invoice.currency;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${esc(invoice.number)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef0f3; color: #333; font: 13px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; }
    .toolbar { max-width: 794px; margin: 16px auto 0; padding: 0 12px; display: flex; justify-content: flex-end; }
    .toolbar button { border: 0; border-radius: 6px; background: #1f5fbf; color: #fff; padding: 10px 16px; font: 600 14px inherit; cursor: pointer; }
    .sheet { max-width: 794px; margin: 12px auto 32px; background: #fff; padding: 56px 60px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .top { display: flex; justify-content: space-between; gap: 24px; }
    .from p { margin: 0; }
    .from .name { font-weight: 700; }
    .title { text-align: right; }
    .title h1 { margin: 0; font-size: 36px; font-weight: 400; letter-spacing: .5px; color: #000; }
    .title .num { margin: 2px 0 0; font-weight: 700; }
    .title .bal-label { margin: 22px 0 0; font-size: 11px; font-weight: 700; }
    .title .bal { margin: 2px 0 0; font-size: 16px; font-weight: 700; }
    .meta { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-top: 36px; }
    .bill p { margin: 0; }
    .bill .name { font-weight: 700; }
    .dates { border-collapse: collapse; }
    .dates td { padding: 4px 0 4px 24px; text-align: right; }
    .dates td:first-child { color: #333; }
    table.items { width: 100%; border-collapse: collapse; margin-top: 26px; }
    table.items th { background: #3c3d3a; color: #fff; font-weight: 400; padding: 8px 10px; text-align: right; }
    table.items th:nth-child(1), table.items th:nth-child(2) { text-align: left; }
    table.items td { padding: 10px; border-bottom: 1px solid #adadad; vertical-align: top; text-align: right; }
    table.items td:nth-child(1), table.items td:nth-child(2) { text-align: left; }
    table.items td:nth-child(1) { width: 36px; }
    .detail { color: #666; font-size: 12px; white-space: pre-line; }
    .totals { margin: 8px 0 0 auto; width: min(100%, 340px); border-collapse: collapse; }
    .totals td { padding: 8px 10px; text-align: right; }
    .totals .strong td { font-weight: 700; }
    .totals .paid td:last-child { color: #e02b27; }
    .totals .due td { background: #f5f4f3; font-weight: 700; }
    .notes { margin-top: 40px; }
    .notes h2 { margin: 0 0 8px; font-size: 13px; font-weight: 400; }
    .notes p { margin: 0; font-size: 11.5px; white-space: pre-line; }
    @media print { body { background: #fff; } .toolbar { display: none; } .sheet { margin: 0; box-shadow: none; padding: 0; } }
    @media (max-width: 620px) {
      .sheet { margin: 8px 0 0; padding: 24px 16px; }
      .top, .meta { flex-direction: column; align-items: stretch; }
      .title { text-align: left; }
      .dates td { padding-left: 0; padding-right: 16px; text-align: left; }
      table.items th, table.items td { padding: 8px 6px; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <main class="sheet">
    <section class="top">
      <div class="from">
        <p class="name">${esc(b.name)}</p>
        ${b.addressLines.map((l) => `<p>${esc(l)}</p>`).join("")}
        <p>${esc(b.email)}</p>
      </div>
      <div class="title">
        <h1>INVOICE</h1>
        <p class="num"># ${esc(invoice.number)}</p>
        <p class="bal-label">Balance Due</p>
        <p class="bal">${esc(cur)}${esc(moneyCommas(invoice.balanceDue))}</p>
      </div>
    </section>
    <section class="meta">
      <div class="bill">
        <p>Bill To</p>
        <p class="name">${esc(invoice.billTo.name)}</p>
      </div>
      <table class="dates">
        <tr><td>Invoice Date :</td><td>${esc(displayDate(invoice.invoiceDate))}</td></tr>
        <tr><td>Terms :</td><td>${esc(invoice.terms)}</td></tr>
        <tr><td>Due Date :</td><td>${esc(displayDate(invoice.dueDate))}</td></tr>
      </table>
    </section>
    <table class="items">
      <thead><tr><th>#</th><th>Item &amp; Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>
        ${invoice.items.map((item, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(item.description)}${item.detail ? `<div class="detail">${esc(item.detail)}</div>` : ""}</td>
          <td>${esc(qtyText(item.qty))}</td>
          <td>${esc(moneyCommas(item.rate))}</td>
          <td>${esc(moneyCommas(item.amount))}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    <table class="totals">
      <tr><td>Sub Total</td><td>${esc(moneyCommas(invoice.subTotal))}</td></tr>
      <tr class="strong"><td>Total</td><td>${esc(cur)}${esc(moneyCommas(invoice.total))}</td></tr>
      ${invoice.paymentMade ? `<tr class="paid"><td>Payment Made</td><td>(-) ${esc(moneyCommas(invoice.paymentMade))}</td></tr>` : ""}
      <tr class="due"><td>Balance Due</td><td>${esc(cur)}${esc(moneyCommas(invoice.balanceDue))}</td></tr>
    </table>
    ${invoice.notes ? `<section class="notes"><h2>Notes</h2><p>${esc(invoice.notes)}</p></section>` : ""}
  </main>
</body>
</html>`;
}

function invoiceEmailHtml(invoice, invoiceUrl) {
  return `<p>Hi ${esc(invoice.billTo.name)},</p>
    <p>Your ${esc(BUSINESS_NAME)} repair invoice <strong>${esc(invoice.number)}</strong> is ready.</p>
    <p><a href="${esc(invoiceUrl)}">View invoice</a></p>
    <p>Total: <strong>${esc(invoice.currency)} ${money(invoice.total)}</strong><br>
    Balance due: <strong>${esc(invoice.currency)} ${money(invoice.balanceDue)}</strong></p>
    <p>Thank you for choosing ${esc(BUSINESS_NAME)}.</p>`;
}

/* ---- Normalizing -------------------------------------------------------- */

function normalizeInvoice(input) {
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((item) => {
      const qty = positiveNumber(item.qty, 1);
      const rate = moneyNumber(item.rate);
      return {
        description: text(item.description).slice(0, 300),
        detail: String(item.detail || "").trim().slice(0, 1000),
        qty,
        rate,
        amount: moneyNumber(qty * rate),
      };
    })
    .filter((item) => item.description || item.rate);
  const subTotal = moneyNumber(items.reduce((sum, item) => sum + item.amount, 0));
  const paymentMade = moneyNumber(input.paymentMade);
  const invoiceDate = dateOnly(input.invoiceDate) || shopToday();
  return {
    number: text(input.number).slice(0, 40) || "INV",
    invoiceDate,
    dueDate: dateOnly(input.dueDate) || invoiceDate,
    terms: text(input.terms).slice(0, 60) || "Due on Receipt",
    billTo: {
      name: text(input.billTo?.name).slice(0, 200),
      phone: text(input.billTo?.phone).slice(0, 60),
      email: text(input.billTo?.email).slice(0, 200),
    },
    items,
    subTotal,
    total: subTotal,
    paymentMade,
    balanceDue: moneyNumber(subTotal - paymentMade),
    notes: String(input.notes ?? "").trim().slice(0, 8000),
    ticketIds: (Array.isArray(input.ticketIds) ? input.ticketIds : []).map(text).filter(Boolean),
    currency: CURRENCY,
  };
}

// Invoices from before line items: one line for the device's repair.
function legacyItems(src) {
  const device = text(src.device);
  const issues = text(src.issues || src.issue);
  return [{
    description: device ? `${device} Repair` : "Device repair",
    detail: issues,
    qty: 1,
    rate: src.repairCost ?? src.total ?? 0,
  }];
}

function rowToInvoice(row) {
  const payload = typeof row.payload === "object" && row.payload ? row.payload : {};
  const hasStructure = Array.isArray(payload.items);
  const invoice = normalizeInvoice(hasStructure ? payload : {
    number: row.id,
    invoiceDate: dateOnly(row.created_at),
    billTo: { name: row.customer_name, phone: row.phone, email: row.email },
    items: legacyItems({ device: row.device, issues: row.issues, repairCost: row.repair_cost }),
    paymentMade: row.amount_paid,
    notes: row.notes,
    ticketIds: [row.ticket_id],
  });
  return {
    ...invoice,
    id: row.id,
    token: row.token,
    currency: row.currency || CURRENCY,
    business: INVOICE_BUSINESS,
    emailedAt: row.emailed_at ? new Date(row.emailed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: payload.updatedAt || null,
  };
}

/* ---- Helpers ------------------------------------------------------------ */

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function formatInvoiceNumber(n) {
  return "INV-" + String(n).padStart(6, "0");
}

function shopToday() {
  // en-CA formats as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: SHOP_TIME_ZONE });
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return isNaN(value) ? "" : value.toLocaleDateString("en-CA", { timeZone: SHOP_TIME_ZONE });
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? "" : d.toLocaleDateString("en-CA", { timeZone: SHOP_TIME_ZONE });
}

function displayDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${m[3]} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

function text(value) {
  return String(value ?? "").trim();
}

function moneyNumber(value) {
  const num = Number(String(value ?? "").replace(/[^0-9.-]/g, "") || 0);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : fallback;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function moneyCommas(value) {
  return Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qtyText(value) {
  return Number(value || 0).toFixed(2);
}

function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

// wa.me needs the full international number, but staff write local Trinidad
// & Tobago (+1 868) numbers as 7 digits ("345-3937") or 10 ("8686820138") —
// raw digits produced broken links for those. Mirrors assets/intake.js's
// whatsAppNumber().
function whatsAppNumber(value) {
  const digits = digitsOnly(value);
  if (digits.length === 7) return "1868" + digits;
  if (digits.length === 10 && digits.startsWith("868")) return "1" + digits;
  if (digits.length >= 11) return digits;
  return "";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
