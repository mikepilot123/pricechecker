import { ensureSchema } from "../lib/db.js";
import { createInvoice, getInvoiceByToken, invoiceHtml, invoiceWhatsAppUrl, sendInvoiceEmail } from "../lib/invoices.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    await ensureSchema();
    if (req.method === "GET") return viewInvoice(req, res);
    if (req.method === "POST") return createAndDeliverInvoice(req, res);
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

async function viewInvoice(req, res) {
  const invoice = await getInvoiceByToken(req.query?.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(invoiceHtml(invoice));
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
