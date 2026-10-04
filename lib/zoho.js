// Zoho Books sync — invoices (with their payments) and expenses created in
// the app are copied to the shop's Zoho Books organisation as they're saved.
//
// • Off until connected in Settings → Zoho Books. Every hook below returns
//   straight away when there's no connection, so nothing else changes.
// • Only records created after the connection are sent ("from now on"):
//   older invoices/expenses are never pushed, even when edited later.
// • A failed send never fails the save in the app. It's logged in
//   zoho_links as "failed" with Zoho's message and retried on the next
//   successful sync or from Settings.
// • Payments follow the invoice's Payment Made: whatever has been paid in the
//   app beyond what Zoho already has is recorded as a Zoho customer payment,
//   cash or bank transfer from the repair's payment method.
// Keys are stored encrypted (AES-256-GCM) in app_settings, never returned to
// the browser. See migrations/042_create_zoho_links.sql for the tables.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sql } from "./db.js";

const SETTINGS_KEY = "zoho";
export const ZOHO_DATA_CENTERS = {
  com: "United States / global (zoho.com)",
  eu: "Europe (zoho.eu)",
  in: "India (zoho.in)",
  "com.au": "Australia (zoho.com.au)",
  ca: "Canada (zoho.ca)",
  jp: "Japan (zoho.jp)",
  sa: "Saudi Arabia (zoho.sa)",
};
const REQUEST_TIMEOUT_MS = 15000;
const ACCOUNTS_TTL_MS = 24 * 60 * 60 * 1000;

/* ---- Small helpers ------------------------------------------------------- */
const text = (v) => String(v == null ? "" : v).trim();
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const digits = (v) => String(v || "").replace(/\D/g, "");
const hash = (v) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

function shopToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port_of_Spain" }).format(new Date());
}

function key() {
  const secret = process.env.ZOHO_CREDENTIALS_KEY || `zoho-credentials:${process.env.DATABASE_URL || process.env.POSTGRES_URL || ""}`;
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
  if (version !== "v1") throw new Error("Zoho isn't connected — reconnect it in Settings → Zoho Books.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("The saved Zoho keys can't be read any more — reconnect in Settings → Zoho Books.");
  }
}

/* ---- Connection ---------------------------------------------------------- */
async function readConfig() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY}`;
  const value = rows.length ? rows[0].value : null;
  return value && value.refreshTokenEnc ? value : null;
}

async function writeConfig(value) {
  await sql`
    INSERT INTO app_settings (key, value) VALUES (${SETTINGS_KEY}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

const accountsUrl = (dc) => `https://accounts.zoho.${dc}`;
const defaultApiDomain = (dc) => `https://www.zohoapis.${dc}`;

async function tokenRequest(dc, params) {
  const res = await fetch(`${accountsUrl(dc)}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    const reason = data.error === "invalid_code"
      ? "That code has expired or was already used — generate a new one in the Zoho API Console (they last a few minutes)."
      : data.error === "invalid_client"
        ? "Zoho didn't recognise the Client ID / Client Secret, or the data centre is wrong."
        : `Zoho refused the connection${data.error ? ` (${data.error})` : ""}.`;
    throw new Error(reason);
  }
  return data;
}

/**
 * One-time setup from Settings: swaps the Self Client grant code for a
 * refresh token, checks it can see the organisation, and saves it. The
 * "from now on" cutoff is kept across reconnects so nothing saved while the
 * connection was broken is skipped — those come back as retryable failures.
 */
export async function connectZoho(input = {}) {
  const clientId = text(input.clientId);
  const clientSecret = text(input.clientSecret);
  const organizationId = digits(input.organizationId);
  const dataCenter = ZOHO_DATA_CENTERS[text(input.dataCenter)] ? text(input.dataCenter) : "com";
  const code = text(input.code);
  if (!clientId || !clientSecret) throw new Error("Enter the Client ID and Client Secret from the Zoho API Console.");
  if (!organizationId) throw new Error("Enter your Zoho Books Organization ID (Settings → Organization Profile in Zoho Books).");
  if (!code) throw new Error("Paste the code you generated in the Zoho API Console.");
  const token = await tokenRequest(dataCenter, {
    grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code,
  });
  if (!token.refresh_token) throw new Error("Zoho didn't return a long-lived token. Generate a fresh code and try again.");
  const previous = await sql`SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY}`;
  const prior = previous.length ? previous[0].value || {} : {};
  const config = {
    clientId,
    clientSecretEnc: encrypt(clientSecret),
    refreshTokenEnc: encrypt(token.refresh_token),
    accessTokenEnc: encrypt(token.access_token),
    accessTokenExpiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
    apiDomain: text(token.api_domain) || defaultApiDomain(dataCenter),
    organizationId,
    dataCenter,
    connectedAt: prior.connectedAt && prior.organizationId === organizationId ? prior.connectedAt : new Date().toISOString(),
    accounts: null,
  };
  // Prove the token can reach this organisation before saving it.
  const org = await zohoRequest(config, "GET", `/organizations/${organizationId}`);
  config.organizationName = text(org.organization?.name);
  await writeConfig(config);
  return zohoStatus();
}

export async function disconnectZoho() {
  await sql`DELETE FROM app_settings WHERE key = ${SETTINGS_KEY}`;
  return zohoStatus();
}

async function accessToken(config, { force = false } = {}) {
  if (!force && config.accessTokenEnc && Number(config.accessTokenExpiresAt) > Date.now() + 60000) {
    return decrypt(config.accessTokenEnc);
  }
  const token = await tokenRequest(config.dataCenter, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: decrypt(config.clientSecretEnc),
    refresh_token: decrypt(config.refreshTokenEnc),
  });
  config.accessTokenEnc = encrypt(token.access_token);
  config.accessTokenExpiresAt = Date.now() + (Number(token.expires_in) || 3600) * 1000;
  if (token.api_domain) config.apiDomain = text(token.api_domain);
  // Shared across serverless instances so each one doesn't mint its own.
  await sql`
    UPDATE app_settings SET value = value || ${JSON.stringify({
      accessTokenEnc: config.accessTokenEnc,
      accessTokenExpiresAt: config.accessTokenExpiresAt,
      apiDomain: config.apiDomain,
    })}::jsonb, updated_at = now()
    WHERE key = ${SETTINGS_KEY}
  `;
  return token.access_token;
}

async function zohoRequest(config, method, path, { query = {}, body } = {}, retried = false) {
  const params = new URLSearchParams({ organization_id: config.organizationId, ...query });
  const res = await fetch(`${config.apiDomain}/books/v3${path}?${params}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${await accessToken(config, { force: retried })}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 && !retried) return zohoRequest(config, method, path, { query, body }, true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code != null && Number(data.code) !== 0)) {
    const err = new Error(text(data.message) || `Zoho returned HTTP ${res.status}`);
    err.zohoCode = data.code;
    throw err;
  }
  return data;
}

/* ---- Chart of accounts --------------------------------------------------- */
// Expense categories in the app → the Zoho expense account names they're
// filed under, best match first. A Zoho account named exactly like the
// category always wins, so renaming/adding accounts in Zoho steers this.
const EXPENSE_ACCOUNT_CANDIDATES = {
  Parts: ["Cost of Goods Sold", "Parts", "Materials", "Purchases"],
  Tools: ["Tools and Equipment", "Tools", "Repairs and Maintenance", "Office Supplies"],
  Rent: ["Rent Expense", "Rent"],
  Utilities: ["Utilities", "Utility Expense", "Electricity", "Telephone Expense"],
  Marketing: ["Advertising And Marketing", "Advertising", "Marketing"],
  "Bank fee": ["Bank Fees and Charges"],
  Inventory: ["Cost of Goods Sold", "Purchases"],
  Payroll: ["Salaries and Employee Wages", "Payroll"],
};
const FALLBACK_EXPENSE_ACCOUNTS = ["Other Expenses", "Uncategorized", "Miscellaneous"];
const EXPENSE_TYPES = new Set(["expense", "cost_of_goods_sold", "other_expense"]);

async function chartOfAccounts(config) {
  const cached = config.accounts;
  if (cached && Date.now() - Number(cached.fetchedAt || 0) < ACCOUNTS_TTL_MS) return cached;
  const data = await zohoRequest(config, "GET", "/chartofaccounts", { query: { filter_by: "AccountType.Active", per_page: "200" } });
  const list = (data.chartofaccounts || []).map((a) => ({ id: String(a.account_id), name: text(a.account_name), type: text(a.account_type) }));
  const cash = list.find((a) => a.type === "cash" && /petty cash/i.test(a.name)) || list.find((a) => a.type === "cash" && !/undeposited/i.test(a.name));
  const bank = list.find((a) => a.type === "bank");
  const accounts = {
    fetchedAt: Date.now(),
    expense: list.filter((a) => EXPENSE_TYPES.has(a.type)),
    cashId: cash?.id || "",
    bankId: bank?.id || "",
  };
  config.accounts = accounts;
  await sql`
    UPDATE app_settings SET value = value || ${JSON.stringify({ accounts })}::jsonb, updated_at = now()
    WHERE key = ${SETTINGS_KEY}
  `;
  return accounts;
}

function expenseAccountFor(accounts, names) {
  const byName = new Map(accounts.expense.map((a) => [a.name.toLowerCase(), a.id]));
  for (const name of names) {
    const id = byName.get(String(name).toLowerCase());
    if (id) return id;
  }
  for (const name of FALLBACK_EXPENSE_ACCOUNTS) {
    const id = byName.get(name.toLowerCase());
    if (id) return id;
  }
  if (accounts.expense[0]) return accounts.expense[0].id;
  throw new Error("Zoho Books has no active expense account to file this under.");
}

/* ---- Customers ----------------------------------------------------------- */
async function customerIdFor(config, billTo) {
  const name = text(billTo?.name) || "Walk-in customer";
  const email = text(billTo?.email).toLowerCase();
  const phone = digits(billTo?.phone);
  const keys = [email && `email:${email}`, phone && `phone:${phone}`, `name:${name.toLowerCase()}`].filter(Boolean);
  const known = await sql`SELECT zoho_contact_id FROM zoho_contacts WHERE contact_key = ANY(${keys}) LIMIT 1`;
  if (known.length) return known[0].zoho_contact_id;

  let id = "";
  const find = async (query) => {
    const data = await zohoRequest(config, "GET", "/contacts", { query: { contact_type: "customer", ...query } });
    return data.contacts?.[0]?.contact_id ? String(data.contacts[0].contact_id) : "";
  };
  if (email) id = await find({ email });
  if (!id && phone) id = await find({ phone: text(billTo.phone) });
  if (!id) {
    try {
      const created = await zohoRequest(config, "POST", "/contacts", {
        body: {
          contact_name: name,
          contact_type: "customer",
          customer_sub_type: "individual",
          ...(email ? { email } : {}),
          ...(phone ? { phone: text(billTo.phone) } : {}),
        },
      });
      id = String(created.contact?.contact_id || "");
    } catch (err) {
      // Zoho display names are unique — reuse the existing contact.
      if (!/exist/i.test(err.message)) throw err;
      id = await find({ contact_name: name });
      if (!id) throw err;
    }
  }
  if (!id) throw new Error("Zoho didn't return a customer for this invoice.");
  for (const k of keys) {
    await sql`
      INSERT INTO zoho_contacts (contact_key, zoho_contact_id) VALUES (${k}, ${id})
      ON CONFLICT (contact_key) DO UPDATE SET zoho_contact_id = EXCLUDED.zoho_contact_id
    `;
  }
  return id;
}

/* ---- Sync bookkeeping ---------------------------------------------------- */
// Claims the record so two saves arriving together can't both create it in
// Zoho. A claim older than two minutes is treated as abandoned.
async function claim(type, localId) {
  const rows = await sql`
    INSERT INTO zoho_links (local_type, local_id, status) VALUES (${type}, ${localId}, 'syncing')
    ON CONFLICT (local_type, local_id) DO UPDATE SET status = 'syncing', updated_at = now()
    WHERE zoho_links.status <> 'syncing' OR zoho_links.updated_at < now() - interval '2 minutes'
    RETURNING *, (xmax = 0) AS inserted
  `;
  return rows[0] || null;
}

async function settle(type, localId, fields) {
  await sql`
    UPDATE zoho_links SET
      zoho_id = COALESCE(${fields.zohoId ?? null}, zoho_id),
      zoho_customer_id = COALESCE(${fields.customerId ?? null}, zoho_customer_id),
      label = COALESCE(${fields.label ?? null}, label),
      synced_hash = COALESCE(${fields.syncedHash ?? null}, synced_hash),
      paid_synced = COALESCE(${fields.paidSynced ?? null}, paid_synced),
      status = ${fields.status},
      last_error = ${fields.error || ""},
      attempts = CASE WHEN ${fields.status} = 'failed' THEN attempts + 1 ELSE 0 END,
      synced_at = CASE WHEN ${fields.status} IN ('synced', 'warning', 'voided', 'deleted') THEN now() ELSE synced_at END,
      updated_at = now()
    WHERE local_type = ${type} AND local_id = ${localId}
  `;
}

async function release(type, localId, wasInserted) {
  if (wasInserted) await sql`DELETE FROM zoho_links WHERE local_type = ${type} AND local_id = ${localId}`;
  else await sql`UPDATE zoho_links SET status = 'skipped', updated_at = now() WHERE local_type = ${type} AND local_id = ${localId} AND zoho_id IS NULL`;
}

function before(row, config) {
  return row.created_at && new Date(row.created_at) < new Date(config.connectedAt);
}

/* ---- Invoices ------------------------------------------------------------ */
function invoiceBody(invoice, customerId, { autoNumber = false } = {}) {
  const refs = (invoice.ticketIds || []).map((id) => `#${id}`).join(", ");
  return {
    customer_id: customerId,
    ...(autoNumber ? {} : { invoice_number: invoice.number }),
    reference_number: (autoNumber ? [`App ${invoice.number}`, refs] : [refs]).filter(Boolean).join(" · ").slice(0, 100),
    date: invoice.invoiceDate,
    due_date: invoice.dueDate,
    line_items: (invoice.items || []).map((item) => ({
      name: text(item.description).slice(0, 100) || "Repair",
      description: text(item.detail).slice(0, 2000),
      rate: money(item.rate),
      quantity: Number(item.qty) || 1,
    })),
    notes: text(invoice.notes).slice(0, 5000),
  };
}

const invoiceHash = (inv) => hash({
  number: inv.number, date: inv.invoiceDate, due: inv.dueDate, billTo: inv.billTo, items: inv.items, notes: inv.notes,
});

async function paymentModeFor(ticketIds) {
  if (!ticketIds?.length) return "cash";
  const rows = await sql`
    SELECT payment_method FROM tickets
    WHERE id = ANY(${ticketIds}) AND payment_method <> ''
    ORDER BY updated_at DESC LIMIT 1
  `;
  return rows[0]?.payment_method === "transfer" ? "banktransfer" : "cash";
}

async function pushInvoice(config, link, row, invoice) {
  const label = `${invoice.number} · ${invoice.billTo?.name || "Customer"}`;
  let zohoId = link.zoho_id;
  let customerId = link.zoho_customer_id;
  let paidSynced = money(link.paid_synced);

  if (row.deleted_at) {
    if (!zohoId) return { status: "skipped", label };
    if (link.status === "voided") return { status: "voided", label };
    try {
      await zohoRequest(config, "POST", `/invoices/${zohoId}/status/void`);
      return { status: "voided", label };
    } catch (err) {
      return { status: "warning", label, error: `Deleted in the app, but Zoho couldn't void it (${err.message}). Void or delete it in Zoho.` };
    }
  }

  const currentHash = invoiceHash(invoice);
  if (!zohoId) {
    customerId = await customerIdFor(config, invoice.billTo);
    let created;
    try {
      created = await zohoRequest(config, "POST", "/invoices", {
        query: { ignore_auto_number_generation: "true" },
        body: invoiceBody(invoice, customerId),
      });
    } catch (err) {
      // The number is already taken in Zoho (e.g. entered there by hand):
      // let Zoho number it and keep the app's number as the reference.
      if (!/invoice number|already exists/i.test(err.message)) throw err;
      created = await zohoRequest(config, "POST", "/invoices", { body: invoiceBody(invoice, customerId, { autoNumber: true }) });
    }
    zohoId = String(created.invoice?.invoice_id || "");
    if (!zohoId) throw new Error("Zoho didn't return the new invoice.");
    // Payments can only be recorded against an invoice that isn't a draft.
    await zohoRequest(config, "POST", `/invoices/${zohoId}/status/sent`).catch(() => {});
    await settle("invoice", row.id, { zohoId, customerId, syncedHash: currentHash, label, status: "syncing" });
  } else if (currentHash !== link.synced_hash) {
    customerId = await customerIdFor(config, invoice.billTo);
    await zohoRequest(config, "PUT", `/invoices/${zohoId}`, {
      query: { ignore_auto_number_generation: "true" },
      body: invoiceBody(invoice, customerId),
    });
    await settle("invoice", row.id, { customerId, syncedHash: currentHash, label, status: "syncing" });
  }

  const paid = money(invoice.paymentMade);
  const delta = money(paid - paidSynced);
  if (delta > 0.004) {
    const mode = await paymentModeFor(invoice.ticketIds);
    const accounts = await chartOfAccounts(config).catch(() => null);
    const accountId = mode === "banktransfer" ? accounts?.bankId : accounts?.cashId;
    await zohoRequest(config, "POST", "/customerpayments", {
      body: {
        customer_id: customerId,
        payment_mode: mode,
        amount: delta,
        date: shopToday(),
        reference_number: invoice.number,
        description: "Recorded in JQ Repair Hub",
        invoices: [{ invoice_id: zohoId, amount_applied: delta }],
        ...(accountId ? { account_id: accountId } : {}),
      },
    });
    paidSynced = paid;
    await settle("invoice", row.id, { paidSynced, status: "syncing" });
  } else if (delta < -0.004) {
    return {
      status: "warning", label, paidSynced: paid,
      error: `Payment Made was lowered by ${Math.abs(delta).toFixed(2)} in the app — adjust or delete that payment in Zoho.`,
    };
  }
  return { status: "synced", label, paidSynced };
}

async function syncInvoiceOnce(config, invoiceId) {
  const [row] = await sql`SELECT * FROM custom_invoices WHERE id = ${invoiceId}`;
  if (!row) return null;
  const link = await claim("invoice", invoiceId);
  if (!link) return null; // another save is syncing it right now
  if (!link.zoho_id && (row.deleted_at || before(row, config))) {
    await release("invoice", invoiceId, link.inserted);
    return null;
  }
  const { invoiceFromRow } = await import("./invoices.js");
  const invoice = invoiceFromRow(row);
  try {
    const result = await pushInvoice(config, link, row, invoice);
    if (result.status === "skipped") await release("invoice", invoiceId, link.inserted);
    else await settle("invoice", invoiceId, result);
    return result.status;
  } catch (err) {
    await settle("invoice", invoiceId, { status: "failed", label: `${invoice.number} · ${invoice.billTo?.name || "Customer"}`, error: err.message });
    return "failed";
  }
}

/* ---- Expenses ------------------------------------------------------------ */
const WITHDRAWAL_CATEGORIES = new Set(["Bank withdrawal", "Cash withdrawal"]);

function expenseAccountNames(row) {
  const category = text(row.category) || "Other";
  // Withdrawals logged on the Account tab arrive as expenses whose vendor
  // is what the money was for ("Rent", "Inventory") — file by that.
  const names = WITHDRAWAL_CATEGORIES.has(category) ? [text(row.vendor)] : [];
  names.push(category, ...(EXPENSE_ACCOUNT_CANDIDATES[category] || []));
  if (WITHDRAWAL_CATEGORIES.has(category)) names.push(...(EXPENSE_ACCOUNT_CANDIDATES[text(row.vendor)] || []));
  return names.filter(Boolean);
}

async function pushExpense(config, link, row) {
  const amount = money(row.amount);
  const label = `${text(row.category) || "Other"}${row.vendor ? ` · ${text(row.vendor)}` : ""} · ${amount.toFixed(2)}`;
  if (row.deleted_at) {
    if (!link.zoho_id) return { status: "skipped", label };
    if (link.status === "deleted") return { status: "deleted", label };
    await zohoRequest(config, "DELETE", `/expenses/${link.zoho_id}`);
    return { status: "deleted", label };
  }
  if (amount <= 0) return { status: link.zoho_id ? "synced" : "skipped", label };
  const accounts = await chartOfAccounts(config);
  const paidThrough = text(row.category) === "Bank withdrawal" ? accounts.bankId || accounts.cashId : accounts.cashId || accounts.bankId;
  const body = {
    account_id: expenseAccountFor(accounts, expenseAccountNames(row)),
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    amount,
    ...(paidThrough ? { paid_through_account_id: paidThrough } : {}),
    description: [text(row.vendor), text(row.notes)].filter(Boolean).join(" — ").slice(0, 100),
  };
  const currentHash = hash(body);
  if (link.zoho_id && currentHash === link.synced_hash) return { status: "synced", label };
  if (link.zoho_id) {
    await zohoRequest(config, "PUT", `/expenses/${link.zoho_id}`, { body });
    return { status: "synced", label, syncedHash: currentHash };
  }
  const created = await zohoRequest(config, "POST", "/expenses", { body });
  const zohoId = String(created.expense?.expense_id || "");
  if (!zohoId) throw new Error("Zoho didn't return the new expense.");
  return { status: "synced", label, zohoId, syncedHash: currentHash };
}

async function syncExpenseOnce(config, expenseId) {
  const [row] = await sql`SELECT * FROM expenses WHERE id = ${expenseId}`;
  if (!row) return null;
  const link = await claim("expense", expenseId);
  if (!link) return null;
  if (!link.zoho_id && (row.deleted_at || before(row, config))) {
    await release("expense", expenseId, link.inserted);
    return null;
  }
  try {
    const result = await pushExpense(config, link, row);
    if (result.status === "skipped") await release("expense", expenseId, link.inserted);
    else await settle("expense", expenseId, result);
    return result.status;
  } catch (err) {
    const label = `${text(row.category) || "Other"}${row.vendor ? ` · ${text(row.vendor)}` : ""} · ${money(row.amount).toFixed(2)}`;
    await settle("expense", expenseId, { status: "failed", label, error: err.message });
    return "failed";
  }
}

/* ---- Hooks (called after every invoice / expense save) ------------------- */
async function hook(kind, id, { retryOthers = true } = {}) {
  const localId = text(id);
  if (!localId) return null;
  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error("Zoho config read failed:", err);
    return null;
  }
  if (!config) return null;
  try {
    const status = kind === "invoice" ? await syncInvoiceOnce(config, localId) : await syncExpenseOnce(config, localId);
    // A working connection is a good moment to clear a couple of earlier
    // failures, so a blip doesn't need anyone to press Retry.
    if (retryOthers && status && status !== "failed") await retryZohoSync({ limit: 2, config });
    return status;
  } catch (err) {
    console.error(`Zoho ${kind} sync failed for ${localId}:`, err);
    return "failed";
  }
}

export const syncInvoiceToZoho = (invoiceId) => hook("invoice", invoiceId);
export const syncExpenseToZoho = (expenseId) => hook("expense", expenseId);

export async function retryZohoSync({ limit = 25, config: given } = {}) {
  const config = given || await readConfig();
  if (!config) throw new Error("Zoho Books isn't connected.");
  const rows = await sql`
    SELECT local_type, local_id FROM zoho_links
    WHERE status = 'failed' OR (status = 'syncing' AND updated_at < now() - interval '2 minutes')
    ORDER BY updated_at ASC LIMIT ${limit}
  `;
  let synced = 0;
  for (const r of rows) {
    const status = r.local_type === "invoice" ? await syncInvoiceOnce(config, r.local_id) : await syncExpenseOnce(config, r.local_id);
    if (status && status !== "failed") synced++;
  }
  return { tried: rows.length, synced };
}

export async function dismissZohoWarning(type, localId) {
  await sql`UPDATE zoho_links SET status = 'synced', last_error = '', updated_at = now() WHERE local_type = ${text(type)} AND local_id = ${text(localId)} AND status = 'warning'`;
  return zohoStatus();
}

export async function zohoStatus() {
  const config = await readConfig().catch(() => null);
  const counts = await sql`
    SELECT local_type, status, COUNT(*)::int AS n FROM zoho_links GROUP BY local_type, status
  `;
  const issues = await sql`
    SELECT local_type, local_id, label, status, last_error, attempts, updated_at FROM zoho_links
    WHERE status IN ('failed', 'warning') ORDER BY updated_at DESC LIMIT 30
  `;
  const count = (type, statuses) => counts.filter((c) => c.local_type === type && statuses.includes(c.status)).reduce((s, c) => s + c.n, 0);
  return {
    connected: !!config,
    organizationId: config?.organizationId || "",
    organizationName: config?.organizationName || "",
    dataCenter: config?.dataCenter || "com",
    connectedAt: config?.connectedAt || null,
    dataCenters: ZOHO_DATA_CENTERS,
    invoices: { synced: count("invoice", ["synced", "voided"]), failed: count("invoice", ["failed"]) },
    expenses: { synced: count("expense", ["synced", "deleted"]), failed: count("expense", ["failed"]) },
    issues: issues.map((r) => ({
      type: r.local_type,
      id: r.local_id,
      label: r.label,
      status: r.status,
      error: r.last_error,
      attempts: r.attempts,
      at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    })),
  };
}
