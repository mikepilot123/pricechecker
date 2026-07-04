import { ensureSchema } from "../lib/db.js";
import { createInvoice, getInvoiceByToken, invoiceHtml, invoiceWhatsAppUrl, sendInvoiceEmail } from "../lib/invoices.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

async function createAndDeliverInvoice(req, res) {
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  if (String(body.pin) !== String(process.env.INTAKE_PIN)) {
    return res.status(200).json({ ok: false, error: "Invalid PIN" });
  }
  const invoice = await createInvoice(body);
  const invoiceUrl = publicInvoiceUrl(req, invoice.token);
  let emailSent = false;
  let emailError = "";
  if (body.delivery !== "whatsapp") {
    try {
      await sendInvoiceEmail(invoice, invoiceUrl);
      emailSent = true;
    } catch (err) {
      emailError = String((err && err.message) || err);
    }
  }
  return res.status(200).json({
    ok: true,
    invoiceId: invoice.id,
    invoiceNumber: invoice.id,
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
