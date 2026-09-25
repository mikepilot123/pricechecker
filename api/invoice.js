import { ensureSchema } from "../lib/db.js";
import { createInvoice, DEFAULT_INVOICE_NOTES, deleteInvoice, getInvoiceById, getInvoiceByToken, getInvoiceForTicket, INVOICE_BUSINESS, invoiceHtml, invoiceWhatsAppUrl, listInvoices, sendInvoiceEmail, updateInvoice } from "../lib/invoices.js";
import { applyCors, checkPin } from "../lib/security.js";

export default async function handler(req, res) {
  // GET serves the customer-facing invoice page as a top-level navigation,
  // where CORS doesn't apply — the allowlist only affects staff-app POSTs.
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    await ensureSchema();
    // Awaited so a rejection inside either handler is caught here instead of
    // escaping as an unhandled rejection (which Vercel turns into a raw
    // FUNCTION_INVOCATION_FAILED 500 with no useful error message).
    if (req.method === "GET") return await viewInvoice(req, res);
    if (req.method === "POST") return await createAndDeliverInvoice(req, res);
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

async function viewInvoice(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    const invoice = await getInvoiceByToken(req.query?.token);
    return res.status(200).send(invoiceHtml(invoice));
  } catch (err) {
    // A customer's browser hits this GET directly, so show a plain page
    // instead of a JSON error blob.
    return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#334">
      <h1>Invoice not found</h1><p>${escapeHtml(String((err && err.message) || err))}</p></body></html>`);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// POST actions (all PIN-protected):
//   create     – new invoice from { billTo, items, paymentMade, ticketIds, … };
//                `send: "email" | "whatsapp"` also delivers it.
//   update     – { id, invoice: { …editable fields } }
//   forTicket  – { ticketId } → the latest invoice containing that repair
//   list       – every invoice (with its customer link), plus the defaults a
//                brand-new invoice starts from
//   send       – { id, delivery } re-delivers an existing invoice
//   delete     – { id } hides the invoice (soft delete)
// No action = the original one-device create-and-send call, still accepted
// so a browser running an older copy of the app keeps working.
async function createAndDeliverInvoice(req, res) {
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const denied = checkPin(req, body.pin);
  if (denied) {
    return res.status(denied.status).json({ ok: false, error: denied.error });
  }
  const action = body.action || "legacy";
  if (action === "update") {
    const invoice = await updateInvoice(body.id, body.invoice || {});
    return res.status(200).json({ ok: true, invoice, invoiceUrl: publicInvoiceUrl(req, invoice.token) });
  }
  if (action === "delete") {
    return res.status(200).json({ ok: true, ...(await deleteInvoice(body.id)) });
  }
  if (action === "list") {
    const invoices = (await listInvoices()).map((invoice) => ({ ...invoice, url: publicInvoiceUrl(req, invoice.token) }));
    return res.status(200).json({ ok: true, invoices, defaults: { business: INVOICE_BUSINESS, notes: DEFAULT_INVOICE_NOTES } });
  }
  if (action === "forTicket") {
    const invoice = await getInvoiceForTicket(body.ticketId);
    return res.status(200).json({ ok: true, invoice, invoiceUrl: invoice ? publicInvoiceUrl(req, invoice.token) : "" });
  }
  let invoice;
  let delivery = "";
  if (action === "send") {
    invoice = await getInvoiceById(body.id);
    delivery = body.delivery === "whatsapp" ? "whatsapp" : "email";
  } else if (action === "create") {
    invoice = await createInvoice(body);
    delivery = body.send === "whatsapp" || body.send === "email" ? body.send : "";
  } else {
    invoice = await createInvoice({ ...body, notes: undefined });
    delivery = body.delivery === "whatsapp" ? "whatsapp" : "email";
  }
  const invoiceUrl = publicInvoiceUrl(req, invoice.token);
  let emailSent = false;
  let emailError = "";
  if (delivery === "email") {
    try {
      await sendInvoiceEmail(invoice, invoiceUrl);
      emailSent = true;
    } catch (err) {
      emailError = String((err && err.message) || err);
    }
  }
  return res.status(200).json({
    ok: true,
    invoice,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    invoiceUrl,
    emailSent,
    emailError,
    whatsappUrl: invoiceWhatsAppUrl(invoice, invoiceUrl),
  });
}

function publicInvoiceUrl(req, token) {
  const base = process.env.PUBLIC_APP_URL || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
  return `${base.replace(/\/$/, "")}/api/invoice?token=${encodeURIComponent(token)}`;
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}
