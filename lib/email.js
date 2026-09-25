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

// Zoho-style message: the staff-written note, then a summary card with the
// balance due and a "View invoice" button.
function invoiceEmailHtml(invoice, message, invoiceUrl) {
  const cur = invoice.currency || "TTD";
  const note = esc(message).replace(/\n/g, "<br>");
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif;color:#333">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e3e6ea">
      <tr><td style="background:#3c3d3a;color:#fff;padding:18px 24px;font-size:16px;font-weight:bold">${esc(invoice.business?.name || "JQ Electronics Ltd.")}</td></tr>
      <tr><td style="padding:24px;font-size:14px;line-height:1.6">${note}</td></tr>
      <tr><td style="padding:0 24px 24px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e6ea;border-radius:6px;background:#fafafa">
          <tr><td style="padding:16px 18px;text-align:center">
            <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.06em">Invoice ${esc(invoice.number)}</div>
            <div style="font-size:26px;font-weight:bold;margin:6px 0;color:#111">${esc(cur)}${esc(money(invoice.balanceDue))}</div>
            <div style="font-size:13px;color:#666">Balance due${invoice.dueDate ? ` · Due ${esc(displayDate(invoice.dueDate))}` : ""}</div>
            <div style="font-size:12px;color:#888;margin-top:4px">Total ${esc(cur)}${esc(money(invoice.total))}${invoice.paymentMade ? ` · Paid ${esc(cur)}${esc(money(invoice.paymentMade))}` : ""}</div>
            ${invoiceUrl ? `<a href="${esc(invoiceUrl)}" style="display:inline-block;margin-top:14px;background:#1f5fbf;color:#fff;text-decoration:none;padding:10px 22px;border-radius:6px;font-weight:bold;font-size:14px">View invoice</a>` : ""}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
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
  const subjectLine = clean(subject, 200) || `Invoice ${invoice.number} from ${invoice.business?.name || "JQ Electronics"}`;
  const body = String(message || "").slice(0, 5000);
  const attachments = [];
  if (pdfBase64) {
    const content = Buffer.from(String(pdfBase64).replace(/^data:[^,]+,/, ""), "base64");
    if (content.length > 5 * 1024 * 1024) throw new Error("The PDF is too large to attach.");
    if (content.slice(0, 4).toString() !== "%PDF") throw new Error("The attachment isn't a PDF.");
    attachments.push({ filename: `${String(invoice.number || "invoice").replace(/[^\w.-]+/g, "_")}.pdf`, content, contentType: "application/pdf" });
  }
  const link = includeLink ? invoiceUrl : "";
  const text = `${body}\n\nInvoice ${invoice.number} — balance due ${invoice.currency || "TTD"}${money(invoice.balanceDue)}${link ? `\nView invoice: ${link}` : ""}`;
  const result = await deliver(sender, {
    to: toList,
    cc: ccList,
    replyTo: sender.fromEmail,
    subject: subjectLine,
    text,
    html: invoiceEmailHtml(invoice, body, link),
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
