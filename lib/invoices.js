import { randomUUID } from "node:crypto";
import { sql } from "./db.js";

const CURRENCY = process.env.INVOICE_CURRENCY || "TTD";
const BUSINESS_NAME = process.env.INVOICE_BUSINESS_NAME || "JQ Electronics";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const INVOICE_FROM_EMAIL = process.env.INVOICE_FROM_EMAIL || "";

export async function createInvoice(input) {
  const invoice = normalizeInvoice(input);
  const rows = await sql`
    INSERT INTO custom_invoices (id, token, ticket_id, customer_name, email, phone, device, issues, status, notes, repair_cost, amount_paid, currency, payload)
    VALUES (${invoice.id}, ${invoice.token}, ${invoice.ticketId}, ${invoice.customerName}, ${invoice.email}, ${invoice.phone}, ${invoice.device}, ${invoice.issues}, ${invoice.status}, ${invoice.notes}, ${invoice.repairCost}, ${invoice.amountPaid}, ${invoice.currency}, ${JSON.stringify(invoice)}::jsonb)
    RETURNING *
  `;
  return rowToInvoice(rows[0]);
}

export async function getInvoiceByToken(token) {
  const key = String(token || "").trim();
  if (!key) throw new Error("Invoice token is required");
  const rows = await sql`SELECT * FROM custom_invoices WHERE token = ${key}`;
  if (!rows.length) throw new Error("Invoice not found");
  return rowToInvoice(rows[0]);
}

export async function sendInvoiceEmail(invoice, invoiceUrl) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  if (!INVOICE_FROM_EMAIL) throw new Error("INVOICE_FROM_EMAIL is not set");
  if (!invoice.email) throw new Error("Customer email is required");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: INVOICE_FROM_EMAIL,
      to: [invoice.email],
      subject: `Your repair invoice - ${invoice.id}`,
      html: invoiceEmailHtml(invoice, invoiceUrl),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("Invoice email failed: " + JSON.stringify(data));
  await sql`UPDATE custom_invoices SET emailed_at = now() WHERE id = ${invoice.id}`;
  return data;
}

export function invoiceWhatsAppUrl(invoice, invoiceUrl) {
  const phone = whatsAppNumber(invoice.phone);
  if (!phone) return "";
  const text = `Hi ${invoice.customerName}, your ${BUSINESS_NAME} repair invoice ${invoice.id} for ${invoice.device || "your device"} is ${invoice.currency} ${money(invoice.total)}.\n${invoiceUrl}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function invoiceHtml(invoice) {
  const balance = Math.max(0, Number(invoice.total) - Number(invoice.amountPaid || 0));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${esc(invoice.id)}</title>
  <style>
    body { margin: 0; background: #f6f8fb; color: #111827; font-family: Inter, Arial, sans-serif; line-height: 1.45; }
    .sheet { max-width: 760px; margin: 24px auto; background: #fff; border: 1px solid #d7dee8; border-radius: 10px; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 20px; border-bottom: 1px solid #d7dee8; padding-bottom: 18px; }
    h1 { margin: 0; font-size: 1.7rem; }
    h2 { margin: 24px 0 10px; font-size: 0.92rem; color: #607086; text-transform: uppercase; letter-spacing: .06em; }
    p { margin: 4px 0; }
    .muted { color: #607086; }
    .right { text-align: right; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #d7dee8; padding: 12px 0; text-align: left; vertical-align: top; }
    th:last-child, td:last-child { text-align: right; }
    .totals { margin-left: auto; width: min(100%, 320px); }
    .total-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #d7dee8; }
    .grand { font-size: 1.2rem; font-weight: 700; }
    @media print { body { background: #fff; } .sheet { margin: 0; border: 0; } }
    @media (max-width: 620px) { .sheet { margin: 0; border-radius: 0; padding: 20px; } header, .grid { display: block; } .right { text-align: left; margin-top: 14px; } }
  </style>
</head>
<body>
  <main class="sheet">
    <header>
      <div>
        <h1>${esc(BUSINESS_NAME)}</h1>
        <p class="muted">Device repair invoice</p>
      </div>
      <div class="right">
        <p><strong>${esc(invoice.id)}</strong></p>
        <p class="muted">${esc(formatDate(invoice.createdAt))}</p>
        <p class="muted">Ticket ${esc(invoice.ticketId)}</p>
      </div>
    </header>
    <section class="grid">
      <div>
        <h2>Bill To</h2>
        <p><strong>${esc(invoice.customerName)}</strong></p>
        <p>${esc(invoice.phone)}</p>
        <p>${esc(invoice.email)}</p>
      </div>
      <div>
        <h2>Device</h2>
        <p><strong>${esc(invoice.device || "Device repair")}</strong></p>
        <p>${esc(invoice.issues || "Repair service")}</p>
        <p class="muted">Status: ${esc(invoice.status || "Received")}</p>
      </div>
    </section>
    <h2>Charges</h2>
    <table>
      <thead><tr><th>Description</th><th>Amount</th></tr></thead>
      <tbody><tr><td>${esc(invoice.device || "Device repair")}<br><span class="muted">${esc(invoice.issues || "")}</span></td><td>${esc(invoice.currency)} ${money(invoice.total)}</td></tr></tbody>
    </table>
    <section class="totals">
      <div class="total-row"><span>Repair cost</span><strong>${esc(invoice.currency)} ${money(invoice.total)}</strong></div>
      <div class="total-row"><span>Amount paid</span><strong>${esc(invoice.currency)} ${money(invoice.amountPaid)}</strong></div>
      <div class="total-row grand"><span>Balance due</span><span>${esc(invoice.currency)} ${money(balance)}</span></div>
    </section>
    ${invoice.notes ? `<h2>Notes</h2><p>${esc(invoice.notes).replace(/\n/g, "<br>")}</p>` : ""}
  </main>
</body>
</html>`;
}

function invoiceEmailHtml(invoice, invoiceUrl) {
  return `<p>Hi ${esc(invoice.customerName)},</p>
    <p>Your ${esc(BUSINESS_NAME)} repair invoice <strong>${esc(invoice.id)}</strong> is ready.</p>
    <p><a href="${esc(invoiceUrl)}">View invoice</a></p>
    <p>Total: <strong>${esc(invoice.currency)} ${money(invoice.total)}</strong></p>
    <p>Thank you for choosing ${esc(BUSINESS_NAME)}.</p>`;
}

function normalizeInvoice(input) {
  const repairCost = moneyNumber(input.repairCost);
  return {
    id: "INV-" + Date.now().toString(36).toUpperCase() + "-" + randomUUID().slice(0, 4).toUpperCase(),
    token: randomUUID(),
    ticketId: text(input.ticketId),
    customerName: text(input.customerName || input.client),
    email: text(input.email),
    phone: text(input.phone),
    device: text(input.device),
    issues: text(input.issues || input.issue),
    status: text(input.status || "Received"),
    notes: cleanNotes(input.notes),
    repairCost,
    amountPaid: moneyNumber(input.amountPaid),
    total: repairCost,
    currency: CURRENCY,
    createdAt: new Date().toISOString(),
  };
}

function rowToInvoice(row) {
  const payload = typeof row.payload === "object" && row.payload ? row.payload : {};
  return Object.assign(payload, {
    id: row.id,
    token: row.token,
    ticketId: row.ticket_id,
    customerName: row.customer_name,
    email: row.email,
    phone: row.phone,
    device: row.device,
    issues: row.issues,
    status: row.status,
    notes: row.notes,
    repairCost: Number(row.repair_cost || 0),
    amountPaid: Number(row.amount_paid || 0),
    total: Number(row.repair_cost || 0),
    currency: row.currency || CURRENCY,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : payload.createdAt,
  });
}

function cleanNotes(value) {
  return text(value).split("\n").filter((line) => !/^Invoice requested by/i.test(line.trim())).join("\n").trim();
}

function text(value) {
  return String(value || "").trim();
}

function moneyNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

function money(value) {
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

function formatDate(value) {
  const date = new Date(value);
  return isNaN(date) ? "" : date.toLocaleDateString("en-TT", { year: "numeric", month: "short", day: "numeric" });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
