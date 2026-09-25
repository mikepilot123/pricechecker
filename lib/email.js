// Sending invoices by email from the shop's own mailboxes.
//
// Staff link one or more "sender" accounts in Settings → Email (Gmail with
// an app password, Zoho Mail, or any SMTP server). Mail goes out through
// that mailbox, so it comes from the shop's real address and lands in its
// Sent folder. If Resend is configured on the server (RESEND_API_KEY +
// INVOICE_FROM_EMAIL) it's offered as an extra sender.
//
// Passwords are encrypted at rest (AES-256-GCM) and never returned to the
// browser. EMAIL_DRY_RUN=1 (the local dev server) captures messages instead
// of sending them.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { sql } from "./db.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.INVOICE_FROM_EMAIL || "";
const RESEND_ID = "resend";
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/* ---- Encryption ---------------------------------------------------------- */
// EMAIL_CREDENTIALS_KEY if set, else derived from DATABASE_URL (a stable
// server-only secret) — so no new setup is needed to start linking accounts.
function key() {
  const secret = process.env.EMAIL_CREDENTIALS_KEY || `email-credentials:${process.env.DATABASE_URL || process.env.POSTGRES_URL || ""}`;
  return createHash("sha256").update(secret).digest();
}

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

function decrypt(stored) {
  const [version, iv, tag, data] = String(stored || "").split(":");
  if (version !== "v1") throw new Error("This account's password needs to be entered again.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("This account's password can't be read any more — edit the account and enter it again.");
  }
}

/* ---- Senders ------------------------------------------------------------- */
const clean = (v, max = 200) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

function rowToSender(row) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    fromName: row.from_name,
    fromEmail: row.from_email,
    host: row.host,
    port: row.port,
    secure: !!row.secure,
    username: row.username,
    hasPassword: !!row.password_enc,
    isDefault: !!row.is_default,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at).toISOString() : null,
    lastError: row.last_error || "",
  };
}

function resendSender(anyDefault) {
  if (!RESEND_API_KEY || !RESEND_FROM) return null;
  return {
    id: RESEND_ID,
    provider: "resend",
    label: "App mail service",
    fromName: "",
    fromEmail: RESEND_FROM.replace(/^.*<([^>]+)>.*$/, "$1"),
    isDefault: !anyDefault,
    builtIn: true,
  };
}

export async function listSenders() {
  const rows = await sql`SELECT * FROM email_accounts ORDER BY is_default DESC, created_at ASC`;
  const senders = rows.map(rowToSender);
  const resend = resendSender(senders.some((s) => s.isDefault));
  return resend ? [...senders, resend] : senders;
}

export async function saveSender(input) {
  const fromEmail = clean(input.fromEmail).toLowerCase();
  if (!EMAIL_RE.test(fromEmail)) throw new Error("Enter a valid email address to send from.");
  const host = clean(input.host, 120).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Enter the mail server (SMTP host), e.g. smtp.gmail.com.");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid port (usually 465 or 587).");
  const secure = input.secure == null ? port === 465 : !!input.secure;
  const username = clean(input.username, 200) || fromEmail;
  const provider = ["gmail", "zoho", "smtp"].includes(input.provider) ? input.provider : "smtp";
  const label = clean(input.label, 80) || fromEmail;
  const fromName = clean(input.fromName, 120);
  const password = input.password ? String(input.password).replace(/\s+/g, provider === "gmail" ? "" : " ").trim() : "";
  const isDefault = !!input.isDefault;

  let id = clean(input.id, 64);
  if (id) {
    const existing = await sql`SELECT id FROM email_accounts WHERE id = ${id}`;
    if (!existing.length) throw new Error("Email account not found.");
    if (password) {
      await sql`UPDATE email_accounts SET password_enc = ${encrypt(password)} WHERE id = ${id}`;
    }
    await sql`
      UPDATE email_accounts
      SET provider = ${provider}, label = ${label}, from_name = ${fromName}, from_email = ${fromEmail},
          host = ${host}, port = ${port}, secure = ${secure}, username = ${username}, updated_at = now()
      WHERE id = ${id}
    `;
  } else {
    if (!password) throw new Error("Enter the password (for Gmail, an app password).");
    id = "EML-" + randomUUID().slice(0, 8).toUpperCase();
    const count = await sql`SELECT COUNT(*)::int AS n FROM email_accounts`;
    await sql`
      INSERT INTO email_accounts (id, provider, label, from_name, from_email, host, port, secure, username, password_enc, is_default)
      VALUES (${id}, ${provider}, ${label}, ${fromName}, ${fromEmail}, ${host}, ${port}, ${secure}, ${username}, ${encrypt(password)}, ${isDefault || count[0].n === 0})
    `;
  }
  if (isDefault) await setDefaultSender(id);
  return (await listSenders()).find((s) => s.id === id);
}

export async function setDefaultSender(id) {
  await sql`UPDATE email_accounts SET is_default = (id = ${clean(id, 64)})`;
  return listSenders();
}

export async function deleteSender(id) {
  const rows = await sql`DELETE FROM email_accounts WHERE id = ${clean(id, 64)} RETURNING is_default`;
  if (!rows.length) throw new Error("Email account not found.");
  if (rows[0].is_default) {
    // Keep a default when other accounts remain.
    await sql`UPDATE email_accounts SET is_default = TRUE WHERE id = (SELECT id FROM email_accounts ORDER BY created_at ASC LIMIT 1)`;
  }
  return listSenders();
}

async function loadSender(id) {
  const all = await listSenders();
  const sender = id ? all.find((s) => s.id === id) : all.find((s) => s.isDefault) || all[0];
  if (!sender) throw new Error("No email account is linked yet — add one in Settings → Email.");
  return sender;
}

/* ---- Transport ----------------------------------------------------------- */
// Messages captured by EMAIL_DRY_RUN (local dev/testing only).
export const dryRunOutbox = [];

async function transportFor(sender) {
  if (process.env.EMAIL_DRY_RUN === "1") {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  const rows = await sql`SELECT password_enc FROM email_accounts WHERE id = ${sender.id}`;
  if (!rows.length || !rows[0].password_enc) throw new Error("This account has no password saved — edit it in Settings → Email.");
  return nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    requireTLS: !sender.secure,
    auth: { user: sender.username, pass: decrypt(rows[0].password_enc) },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

// Turns SMTP errors into something staff can act on.
function friendlySmtpError(err, sender) {
  const msg = String((err && (err.response || err.message)) || err);
  if (/535|534|Username and Password not accepted|Invalid login|authentication failed/i.test(msg)) {
    return sender.provider === "gmail"
      ? "Gmail rejected the login. Use a Google app password (not your normal password) and check the address is right."
      : "The mail server rejected the username or password.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Greeting never received|Connection timeout/i.test(msg)) {
    return `Couldn't reach ${sender.host}:${sender.port} — check the server and port.`;
  }
  return msg.slice(0, 300);
}

async function deliver(sender, message) {
  const from = sender.fromName ? { name: sender.fromName, address: sender.fromEmail } : sender.fromEmail;
  if (sender.id === RESEND_ID && process.env.EMAIL_DRY_RUN !== "1") {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: message.to,
        cc: message.cc && message.cc.length ? message.cc : undefined,
        reply_to: message.replyTo || undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: (message.attachments || []).map((a) => ({ filename: a.filename, content: a.content.toString("base64") })),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error("Email failed: " + (data.message || JSON.stringify(data)));
    return { id: data.id || "" };
  }
  const transport = await transportFor(sender);
  try {
    const info = await transport.sendMail({ from, ...message });
    if (process.env.EMAIL_DRY_RUN === "1") {
      dryRunOutbox.push({ from, ...message, attachments: (message.attachments || []).map((a) => ({ filename: a.filename, bytes: a.content.length })) });
    }
    if (sender.id !== RESEND_ID) {
      await sql`UPDATE email_accounts SET last_tested_at = now(), last_error = '' WHERE id = ${sender.id}`;
    }
    return { id: info.messageId || "" };
  } catch (err) {
    const friendly = friendlySmtpError(err, sender);
    if (sender.id !== RESEND_ID) await sql`UPDATE email_accounts SET last_error = ${friendly} WHERE id = ${sender.id}`;
    throw new Error(friendly);
  }
}

/** Sends a short test message from the account to itself. */
export async function testSender(id) {
  const sender = await loadSender(id);
  await deliver(sender, {
    to: [sender.fromEmail],
    subject: "Test email from JQ Electronics Repair Hub",
    text: "This account is linked correctly — invoices can be emailed from it.",
    html: "<p>This account is linked correctly — invoices can be emailed from it.</p>",
  });
  return { ok: true, sentTo: sender.fromEmail };
}

/* ---- Invoice email -------------------------------------------------------- */
function parseAddresses(value, label) {
  const list = (Array.isArray(value) ? value : String(value || "").split(/[,;\s]+/))
    .map((a) => String(a || "").trim().toLowerCase())
    .filter(Boolean);
  const bad = list.find((a) => !EMAIL_RE.test(a));
  if (bad) throw new Error(`"${bad}" isn't a valid ${label} address.`);
  if (list.length > 10) throw new Error(`Too many ${label} addresses (10 max).`);
  return [...new Set(list)];
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const displayDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};

/* ---- Email template (Settings → Email → Email design) --------------------
   The customer email is Shopify-style: logo + invoice number, a heading and
   the staff's note, a "View invoice" button, an invoice summary, customer
   information and a contact footer. Staff can restyle it and reword it; the
   choices live in app_settings under "invoice_email_template". Text fields
   accept placeholders like {first_name} and are always escaped (plain text,
   never raw HTML). */
const TEMPLATE_KEY = "invoice_email_template";
const DEFAULT_LOGO_URL = process.env.INVOICE_LOGO_URL || "https://mikepilot123.github.io/pricechecker/assets/branding/jq-electronics-logo.png";

export const EMAIL_FONTS = {
  modern: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  classic: "Georgia,'Times New Roman',Times,serif",
  friendly: "'Trebuchet MS','Lucida Grande',Verdana,sans-serif",
};

export const EMAIL_TEMPLATE_DEFAULTS = {
  accentColor: "#1f5fbf",
  font: "modern",
  showLogo: true,
  logoUrl: "",
  logoWidth: 140,
  logoAlign: "left",
  subject: "Invoice {invoice_number} from {business_name}",
  headingDue: "Here's your invoice",
  headingPaid: "Thank you for your payment!",
  showDueLine: true,
  message: "Hi {first_name},\n\nThank you for choosing JQ Electronics! Your invoice is attached as a PDF, and a summary is below.\n\n{sender_name}",
  buttonText: "View invoice",
  showSummary: true,
  showCustomerInfo: true,
  footerText: "If you have any questions, reply to this email or contact us at {business_email}.",
  showAddress: true,
};

export const EMAIL_PLACEHOLDERS = [
  "first_name", "customer_name", "invoice_number", "total", "amount_paid", "balance_due",
  "due_date", "invoice_date", "business_name", "business_email", "sender_name",
];

function normalizeTemplate(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const d = EMAIL_TEMPLATE_DEFAULTS;
  const text = (value, fallback, max) => (value == null ? fallback : String(value).slice(0, max));
  const bool = (value, fallback) => (value == null ? fallback : !!value);
  const url = String(v.logoUrl || "").trim();
  return {
    accentColor: /^#[0-9a-f]{6}$/i.test(v.accentColor || "") ? v.accentColor.toLowerCase() : d.accentColor,
    font: EMAIL_FONTS[v.font] ? v.font : d.font,
    showLogo: bool(v.showLogo, d.showLogo),
    logoUrl: /^https:\/\/[^\s"'<>]+$/i.test(url) ? url.slice(0, 500) : "",
    logoWidth: Math.min(260, Math.max(60, Math.round(Number(v.logoWidth) || d.logoWidth))),
    logoAlign: v.logoAlign === "center" ? "center" : "left",
    subject: text(v.subject, d.subject, 200).replace(/[\r\n]+/g, " "),
    headingDue: text(v.headingDue, d.headingDue, 120),
    headingPaid: text(v.headingPaid, d.headingPaid, 120),
    showDueLine: bool(v.showDueLine, d.showDueLine),
    message: text(v.message, d.message, 3000),
    buttonText: text(v.buttonText, d.buttonText, 40) || d.buttonText,
    showSummary: bool(v.showSummary, d.showSummary),
    showCustomerInfo: bool(v.showCustomerInfo, d.showCustomerInfo),
    footerText: text(v.footerText, d.footerText, 600),
    showAddress: bool(v.showAddress, d.showAddress),
  };
}

export async function getEmailTemplate() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${TEMPLATE_KEY}`;
  return normalizeTemplate(rows.length ? rows[0].value : null);
}

export async function saveEmailTemplate(patch) {
  const merged = normalizeTemplate({ ...(await getEmailTemplate()), ...(patch && typeof patch === "object" ? patch : {}) });
  await sql`
    INSERT INTO app_settings (key, value) VALUES (${TEMPLATE_KEY}, ${JSON.stringify(merged)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return merged;
}

export async function resetEmailTemplate() {
  await sql`DELETE FROM app_settings WHERE key = ${TEMPLATE_KEY}`;
  return normalizeTemplate(null);
}

// Replaces {placeholders} with this invoice's values (unknown ones are left).
export function fillPlaceholders(textValue, invoice, senderName = "") {
  const cur = invoice.currency || "TTD";
  const values = {
    first_name: (invoice.billTo?.name || "").trim().split(/\s+/)[0] || "there",
    customer_name: invoice.billTo?.name || "",
    invoice_number: invoice.number || "",
    total: `${cur}${money(invoice.total)}`,
    amount_paid: `${cur}${money(invoice.paymentMade)}`,
    balance_due: `${cur}${money(invoice.balanceDue)}`,
    due_date: displayDate(invoice.dueDate),
    invoice_date: displayDate(invoice.invoiceDate),
    business_name: invoice.business?.name || "JQ Electronics Ltd.",
    business_email: invoice.business?.email || "",
    sender_name: senderName || "JQ Electronics",
  };
  return String(textValue || "").replace(/\{([a-z_]+)\}/g, (m, k) => (k in values ? values[k] : m));
}

// A realistic invoice for the Settings preview.
export function sampleInvoice(business) {
  return {
    number: "INV-000123",
    currency: "TTD",
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    terms: "Due on Receipt",
    billTo: { name: "Ryan Rampersad", phone: "868 444 5555", email: "ryan@example.com" },
    items: [
      { description: "HP Stream Keyboard Replacement", detail: "Custom order — 2 weeks", qty: 1, rate: 900, amount: 900 },
      { description: "Courier Pick up and Drop off fee", detail: "", qty: 1, rate: 150, amount: 150 },
    ],
    subTotal: 1050,
    total: 1050,
    paymentMade: 750,
    balanceDue: 300,
    business,
  };
}

// Table-based with inline styles so it renders the same in Gmail, Outlook
// and on phones.
export function invoiceEmailHtml(invoice, message, invoiceUrl, template, senderName = "") {
  const t = normalizeTemplate(template);
  const FONT = EMAIL_FONTS[t.font];
  const accent = t.accentColor;
  const fill = (v) => fillPlaceholders(v, invoice, senderName);
  const cur = invoice.currency || "TTD";
  const b = invoice.business || {};
  const balance = Number(invoice.balanceDue || 0);
  const paid = Number(invoice.paymentMade || 0);
  const isPaid = balance <= 0.004;
  const heading = fill(isPaid ? t.headingPaid : t.headingDue);
  const sub = !t.showDueLine ? "" : isPaid
    ? "This invoice is paid in full. A copy is attached for your records."
    : `${esc(cur)}${esc(money(balance))} is due${invoice.dueDate ? ` by ${esc(displayDate(invoice.dueDate))}` : ""}.`;
  const note = esc(message).trim().replace(/\n/g, "<br>");
  const footer = esc(fill(t.footerText)).trim().replace(/\n/g, "<br>")
    .replace(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, `<a href="mailto:$1" style="color:${accent};text-decoration:none">$1</a>`);
  const muted = "color:#777777";
  const rule = `<tr><td style="border-top:1px solid #e5e5e5;font-size:0;line-height:0;height:1px">&nbsp;</td></tr>`;
  const sectionTitle = (title) => `<h3 style="margin:0 0 20px;font-size:20px;font-weight:normal;color:#333333">${title}</h3>`;
  const logo = t.showLogo
    ? `<img src="${esc(t.logoUrl || DEFAULT_LOGO_URL)}" width="${t.logoWidth}" alt="${esc(b.name || "JQ Electronics")}" style="display:${t.logoAlign === "center" ? "inline-block" : "block"};width:${t.logoWidth}px;max-width:100%;height:auto;border:0">`
    : `<span style="font-size:20px;font-weight:600;color:#333333">${esc(b.name || "JQ Electronics Ltd.")}</span>`;
  const header = t.logoAlign === "center"
    ? `<tr><td style="padding:40px 0 10px;text-align:center">${logo}</td></tr>
       <tr><td style="padding:0 0 30px;text-align:center;text-transform:uppercase;font-size:14px;${muted};letter-spacing:.02em">Invoice ${esc(invoice.number)}</td></tr>`
    : `<tr><td style="padding:40px 0 30px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle">${logo}</td>
          <td valign="middle" style="text-align:right;text-transform:uppercase;font-size:14px;${muted};letter-spacing:.02em">Invoice ${esc(invoice.number)}</td>
        </tr></table>
      </td></tr>`;

  const itemRows = (invoice.items || []).map((item) => `
    <tr>
      <td style="padding:15px 0;border-bottom:1px solid #e5e5e5;vertical-align:top">
        <span style="font-size:16px;font-weight:600;color:#555555;line-height:1.4">${esc(item.description)}${Number(item.qty) !== 1 ? ` &times; ${esc(item.qty)}` : ""}</span>
        ${item.detail ? `<br><span style="font-size:14px;${muted};line-height:1.4">${esc(item.detail).replace(/\n/g, "<br>")}</span>` : ""}
      </td>
      <td style="padding:15px 0 15px 16px;border-bottom:1px solid #e5e5e5;vertical-align:top;text-align:right;white-space:nowrap">
        <strong style="font-size:16px;color:#555555">${esc(cur)}${esc(money(item.amount))}</strong>
      </td>
    </tr>`).join("");

  const totalRow = (label, value, { strong = false, color = "#555555" } = {}) => `
    <tr>
      <td style="padding:${strong ? "20px 0 0" : "5px 0"};font-size:16px;${muted}">${label}</td>
      <td style="padding:${strong ? "20px 0 0" : "5px 0"};text-align:right;font-size:${strong ? "24px" : "16px"};font-weight:600;color:${color};white-space:nowrap">${value}</td>
    </tr>`;

  const infoBlock = (title, lines) => `
    <td width="50%" valign="top" style="padding:0 16px 30px 0">
      <h4 style="margin:0 0 5px;font-size:16px;font-weight:500;color:#555555">${title}</h4>
      <p style="margin:0;font-size:16px;line-height:150%;${muted}">${lines.filter(Boolean).join("<br>")}</p>
    </td>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;font-family:${FONT}">
  <tr><td align="center" style="padding:0 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
      ${header}

      <tr><td style="padding-bottom:40px">
        <h2 style="margin:0 0 10px;font-size:24px;font-weight:normal;color:#333333">${esc(heading)}</h2>
        ${sub ? `<p style="margin:0 0 16px;font-size:16px;line-height:150%;${muted}">${sub}</p>` : ""}
        ${note ? `<p style="margin:0 0 24px;font-size:16px;line-height:150%;${muted}">${note}</p>` : ""}
        ${invoiceUrl ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px"><tr>
          <td style="border-radius:4px;background:${accent}"><a href="${esc(invoiceUrl)}" style="display:inline-block;padding:20px 25px;font-size:16px;color:#ffffff;text-decoration:none;font-family:${FONT}">${esc(fill(t.buttonText))}</a></td>
          <td style="padding-left:16px;font-size:16px;${muted}">or open the attached PDF</td>
        </tr></table>` : `<p style="margin:0;font-size:16px;${muted}">Your invoice is attached as a PDF.</p>`}
      </td></tr>

      ${t.showSummary ? `${rule}
      <tr><td style="padding:40px 0">
        ${sectionTitle("Invoice summary")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:15px">
          <tr><td width="40%"></td><td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${totalRow("Subtotal", `${esc(cur)}${esc(money(invoice.subTotal ?? invoice.total))}`)}
              ${paid ? totalRow("Paid", `&minus; ${esc(cur)}${esc(money(paid))}`, { color: "#2e7d32" }) : ""}
              <tr><td colspan="2" style="padding-top:15px;border-bottom:1px solid #e5e5e5;font-size:0;line-height:0">&nbsp;</td></tr>
              ${totalRow(isPaid ? "Total" : "Balance due", `${esc(cur)}${esc(money(isPaid ? invoice.total : balance))}`, { strong: true, color: "#333333" })}
              ${isPaid ? "" : `<tr><td colspan="2" style="padding-top:6px;text-align:right;font-size:14px;${muted}">Invoice total ${esc(cur)}${esc(money(invoice.total))}</td></tr>`}
            </table>
          </td></tr>
        </table>
      </td></tr>` : ""}

      ${t.showCustomerInfo ? `${rule}
      <tr><td style="padding:40px 0 10px">
        ${sectionTitle("Customer information")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${infoBlock("Bill to", [esc(invoice.billTo?.name), esc(invoice.billTo?.phone), esc(invoice.billTo?.email)])}
          ${infoBlock("Invoice details", [
            `Invoice ${esc(invoice.number)}`,
            invoice.invoiceDate ? `Issued ${esc(displayDate(invoice.invoiceDate))}` : "",
            invoice.dueDate ? `Due ${esc(displayDate(invoice.dueDate))}` : "",
            esc(invoice.terms || ""),
          ])}
        </tr></table>
      </td></tr>` : ""}

      ${footer || t.showAddress ? `${rule}
      <tr><td style="padding:35px 0 50px">
        ${footer ? `<p style="margin:0 0 6px;font-size:14px;line-height:150%;${muted}">${footer}</p>` : ""}
        ${t.showAddress ? `<p style="margin:0;font-size:14px;line-height:150%;${muted}">${esc(b.name || "JQ Electronics Ltd.")}${(b.addressLines || []).length ? " · " + (b.addressLines || []).map(esc).join(", ") : ""}</p>` : ""}
      </td></tr>` : ""}

    </table>
  </td></tr>
</table>
</body></html>`;
}

// Plain-text version for mail apps that don't show HTML.
function invoiceEmailText(invoice, message, invoiceUrl, template, senderName) {
  const t = normalizeTemplate(template);
  const cur = invoice.currency || "TTD";
  const balance = Number(invoice.balanceDue || 0);
  const lines = [
    `Invoice ${invoice.number}`,
    "",
    String(message || "").trim(),
    "",
    ...(t.showSummary ? [
      "INVOICE SUMMARY",
      ...(invoice.items || []).map((i) => `- ${i.description}${Number(i.qty) !== 1 ? ` x ${i.qty}` : ""}: ${cur}${money(i.amount)}`),
      "",
      `Subtotal: ${cur}${money(invoice.subTotal ?? invoice.total)}`,
      invoice.paymentMade ? `Paid: -${cur}${money(invoice.paymentMade)}` : "",
    ] : []),
    balance > 0.004 ? `Balance due: ${cur}${money(balance)}${invoice.dueDate ? ` (due ${displayDate(invoice.dueDate)})` : ""}` : `Total: ${cur}${money(invoice.total)} — paid in full`,
    "",
    invoiceUrl ? `${fillPlaceholders(t.buttonText, invoice, senderName)}: ${invoiceUrl}` : "",
    "The invoice PDF is attached.",
    "",
    fillPlaceholders(t.footerText, invoice, senderName),
  ];
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim();
}

/**
 * Emails an invoice. `pdfBase64` is the PDF the app generated (the same file
 * as Download PDF) and is attached when present.
 */
export async function sendInvoiceMail({ invoice, senderId, to, cc, subject, message, pdfBase64, includeLink, invoiceUrl }) {
  const sender = await loadSender(senderId);
  const toList = parseAddresses(to, "To");
  if (!toList.length) throw new Error("Enter the customer's email address.");
  const ccList = parseAddresses(cc, "CC");
  const template = await getEmailTemplate();
  const subjectLine = clean(subject, 200) || clean(fillPlaceholders(template.subject, invoice, sender.fromName), 200);
  const body = String(message || "").slice(0, 5000);
  const attachments = [];
  if (pdfBase64) {
    const content = Buffer.from(String(pdfBase64).replace(/^data:[^,]+,/, ""), "base64");
    if (content.length > 5 * 1024 * 1024) throw new Error("The PDF is too large to attach.");
    if (content.slice(0, 4).toString() !== "%PDF") throw new Error("The attachment isn't a PDF.");
    attachments.push({ filename: `${String(invoice.number || "invoice").replace(/[^\w.-]+/g, "_")}.pdf`, content, contentType: "application/pdf" });
  }
  const link = includeLink ? invoiceUrl : "";
  const text = invoiceEmailText(invoice, body, link, template, sender.fromName);
  const result = await deliver(sender, {
    to: toList,
    cc: ccList,
    replyTo: sender.fromEmail,
    subject: subjectLine,
    text,
    html: invoiceEmailHtml(invoice, body, link, template, sender.fromName),
    attachments,
  });
  return {
    messageId: result.id,
    from: sender.fromEmail,
    to: toList,
    cc: ccList,
    subject: subjectLine,
    attached: attachments.length > 0,
    sentAt: new Date().toISOString(),
  };
}
