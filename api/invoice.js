import { ensureSchema } from "../lib/db.js";
import { deleteSender, EMAIL_PLACEHOLDERS, EMAIL_TEMPLATE_DEFAULTS, fillPlaceholders, getEmailTemplate, invoiceEmailHtml, listSenders, resetEmailTemplate, sampleInvoice, saveEmailTemplate, saveSender, sendInvoiceMail, setDefaultSender, testSender } from "../lib/email.js";
import { createInvoice, DEFAULT_INVOICE_NOTES, deleteInvoice, recordInvoiceEmail, getInvoiceById, getInvoiceByToken, getInvoiceForTicket, INVOICE_BUSINESS, invoiceHtml, invoiceWhatsAppUrl, listInvoices, sendInvoiceEmail, updateInvoice } from "../lib/invoices.js";
import { applyCors, checkPin } from "../lib/security.js";
import { drawInvoicePdf, invoicePdfName } from "../lib/invoice-pdf.js";

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

// Customer-facing link. ?format=pdf (the "View invoice" button in emails)
// returns the invoice PDF — the same file the app attaches — to open in the
// browser; without it, the web version of the invoice.
async function viewInvoice(req, res) {
  let invoice;
  try {
    invoice = await getInvoiceByToken(req.query?.token);
  } catch (err) {
    // A customer's browser hits this directly, so show a plain page instead
    // of a JSON error blob.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(404).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invoice unavailable</title></head>
      <body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;padding:60px 20px;color:#334">
      <h1 style="font-size:22px">This invoice link is no longer available</h1>
      <p style="max-width:420px;margin:12px auto;line-height:1.5;color:#607086">The invoice may have been replaced or removed. Please contact ${escapeHtml(INVOICE_BUSINESS.name)}${INVOICE_BUSINESS.email ? ` at <a href="mailto:${escapeHtml(INVOICE_BUSINESS.email)}">${escapeHtml(INVOICE_BUSINESS.email)}</a>` : ""} for a current copy.</p>
      </body></html>`);
  }
  if (String(req.query?.format || "").toLowerCase() === "pdf") {
    const pdf = await invoicePdfBuffer(invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoicePdfName(invoice)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).send(pdf);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(invoiceHtml(invoice));
}

async function invoicePdfBuffer(invoice) {
  const { jsPDF } = await import("jspdf");
  return Buffer.from(drawInvoicePdf(jsPDF, invoice).output("arraybuffer"));
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
//   email      – { id, senderId, to, cc, subject, message, pdfBase64,
//                  includeLink } sends it from a linked mailbox (lib/email.js)
//   senders / saveSender / deleteSender / defaultSender / testSender —
//                manage those mailboxes (Settings → Email)
//   emailTemplate / saveEmailTemplate / resetEmailTemplate / previewEmail —
//                the customer email's design (Settings → Email → Email design)
//   emailDraft – { id, senderName } → subject + message from the template
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
  if (action === "emailTemplate") {
    return res.status(200).json({ ok: true, template: await getEmailTemplate(), defaults: EMAIL_TEMPLATE_DEFAULTS, placeholders: EMAIL_PLACEHOLDERS });
  }
  if (action === "saveEmailTemplate") {
    return res.status(200).json({ ok: true, template: await saveEmailTemplate(body.template || {}) });
  }
  if (action === "resetEmailTemplate") {
    return res.status(200).json({ ok: true, template: await resetEmailTemplate() });
  }
  if (action === "previewEmail") {
    // Unsaved template from the editor, rendered with a sample invoice.
    const invoice = sampleInvoice(INVOICE_BUSINESS);
    if (body.paid) { invoice.paymentMade = invoice.total; invoice.balanceDue = 0; }
    const template = body.template || (await getEmailTemplate());
    const senderName = String(body.senderName || "JQ Electronics").slice(0, 120);
    const message = fillPlaceholders(template.message ?? EMAIL_TEMPLATE_DEFAULTS.message, invoice, senderName);
    return res.status(200).json({
      ok: true,
      subject: fillPlaceholders(template.subject ?? EMAIL_TEMPLATE_DEFAULTS.subject, invoice, senderName),
      html: invoiceEmailHtml(invoice, message, "https://example.com/invoice", template, senderName),
    });
  }
  if (action === "emailDraft") {
    const invoice = await getInvoiceById(body.id);
    const template = await getEmailTemplate();
    const senderName = String(body.senderName || "").slice(0, 120);
    return res.status(200).json({
      ok: true,
      subject: fillPlaceholders(template.subject, invoice, senderName),
      message: fillPlaceholders(template.message, invoice, senderName),
    });
  }
  if (action === "senders") {
    return res.status(200).json({ ok: true, senders: await listSenders() });
  }
  if (action === "saveSender") {
    const sender = await saveSender(body.sender || {});
    return res.status(200).json({ ok: true, sender, senders: await listSenders() });
  }
  if (action === "deleteSender") {
    return res.status(200).json({ ok: true, senders: await deleteSender(body.id) });
  }
  if (action === "defaultSender") {
    return res.status(200).json({ ok: true, senders: await setDefaultSender(body.id) });
  }
  if (action === "testSender") {
    return res.status(200).json({ ok: true, ...(await testSender(body.id)), senders: await listSenders() });
  }
  if (action === "email") {
    const invoice = await getInvoiceById(body.id);
    // The email's "View invoice" button opens the PDF.
    const invoiceUrl = publicInvoiceUrl(req, invoice.token) + "&format=pdf";
    const sent = await sendInvoiceMail({ ...body, invoice, invoiceUrl });
    const updated = await recordInvoiceEmail(invoice.id, sent);
    return res.status(200).json({ ok: true, sent, invoice: updated, invoiceUrl });
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
