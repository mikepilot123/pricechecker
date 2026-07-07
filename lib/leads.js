import { sql } from "./db.js";

export const LEAD_STATUSES = ["New", "Contacted", "Quoted", "Follow-up", "Won", "Lost"];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function moneyFrom(value) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Quoted amount must be a valid non-negative amount");
  return (Math.round(Number(raw) * 100) / 100).toFixed(2);
}

function dateFrom(value) {
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Follow-up date must be YYYY-MM-DD");
  return raw;
}

function statusFrom(value, fallback = "New") {
  const status = text(value) || fallback;
  return LEAD_STATUSES.includes(status) ? status : fallback;
}

function rowToLead(row) {
  return {
    id: row.id,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    customerName: row.customer_name || "",
    phone: row.phone || "",
    email: row.email || "",
    device: row.device || "",
    issue: row.issue || "",
    quotedAmount: row.quoted_amount == null ? "" : String(row.quoted_amount),
    source: row.source || "",
    status: row.status || "New",
    followUpDate: row.follow_up_date ? dateFrom(row.follow_up_date) : "",
    notesCount: row.notes_count == null ? 0 : Number(row.notes_count),
  };
}

function rowToLeadNote(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    note: row.note || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function getLead(id) {
  const rows = await sql`
    SELECT leads.*, (
      SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (lead_notes.lead_id, btrim(lead_notes.note)) lead_notes.id
        FROM lead_notes
        WHERE lead_notes.lead_id = leads.id
        ORDER BY lead_notes.lead_id, btrim(lead_notes.note), lead_notes.created_at DESC, lead_notes.id DESC
      ) deduped_lead_notes
    ) AS notes_count
    FROM leads WHERE leads.id = ${id}
  `;
  if (!rows.length) throw new Error("Lead not found: " + id);
  return rowToLead(rows[0]);
}

export async function listLeads({ includeDeleted = false } = {}) {
  const rows = includeDeleted
    ? await sql`
        SELECT leads.*, (
          SELECT COUNT(*) FROM (
            SELECT DISTINCT ON (lead_notes.lead_id, btrim(lead_notes.note)) lead_notes.id
            FROM lead_notes
            WHERE lead_notes.lead_id = leads.id
            ORDER BY lead_notes.lead_id, btrim(lead_notes.note), lead_notes.created_at DESC, lead_notes.id DESC
          ) deduped_lead_notes
        ) AS notes_count
        FROM leads ORDER BY updated_at DESC
      `
    : await sql`
        SELECT leads.*, (
          SELECT COUNT(*) FROM (
            SELECT DISTINCT ON (lead_notes.lead_id, btrim(lead_notes.note)) lead_notes.id
            FROM lead_notes
            WHERE lead_notes.lead_id = leads.id
            ORDER BY lead_notes.lead_id, btrim(lead_notes.note), lead_notes.created_at DESC, lead_notes.id DESC
          ) deduped_lead_notes
        ) AS notes_count
        FROM leads WHERE deleted_at IS NULL ORDER BY updated_at DESC
      `;
  return rows.map(rowToLead);
}

export async function listLeadNotes(leadId) {
  const id = text(leadId);
  if (!id) throw new Error("Lead ID is required");
  const rows = await sql`
    SELECT DISTINCT ON (lead_id, btrim(note)) *
    FROM lead_notes
    WHERE lead_id = ${id}
    ORDER BY lead_id, btrim(note), created_at DESC, id DESC
  `;
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || Number(b.id) - Number(a.id));
  return rows.map(rowToLeadNote);
}

export async function addLeadNote(p) {
  const leadId = text(p.leadId != null ? p.leadId : p.lead_id);
  const note = text(p.note);
  if (!leadId) throw new Error("Lead ID is required");
  if (!note) throw new Error("Note text is required");
  const rows = await sql`SELECT id FROM leads WHERE id = ${leadId} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Lead not found: " + leadId);
  await sql`
    INSERT INTO lead_notes (lead_id, note)
    SELECT ${leadId}, ${note}
    WHERE NOT EXISTS (
      SELECT 1 FROM lead_notes
      WHERE lead_id = ${leadId} AND btrim(note) = btrim(${note})
    )
  `;
  await sql`UPDATE leads SET updated_at = now() WHERE id = ${leadId}`;
  return listLeadNotes(leadId);
}

export async function addLead(p) {
  const id = "L" + Date.now().toString(36).toUpperCase();
  const customerName = text(p.customerName != null ? p.customerName : p.name);
  const phone = text(p.phone);
  if (!customerName && !phone) throw new Error("Lead name or phone is required");
  await sql`
    INSERT INTO leads (id, customer_name, phone, email, device, issue, quoted_amount, source, status, follow_up_date, notes)
    VALUES (
      ${id},
      ${customerName},
      ${phone},
      ${text(p.email)},
      ${text(p.device)},
      ${text(p.issue)},
      ${moneyFrom(p.quotedAmount != null ? p.quotedAmount : p.quoted_amount)},
      ${text(p.source)},
      ${statusFrom(p.status)},
      ${dateFrom(p.followUpDate != null ? p.followUpDate : p.follow_up_date)},
      ${text(p.notes)}
    )
  `;
  return getLead(id);
}

export async function updateLead(p) {
  const id = text(p.id);
  if (!id) throw new Error("Lead ID is required");
  const rows = await sql`SELECT * FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Lead not found: " + id);
  const current = rows[0];
  const customerName = p.customerName != null || p.name != null ? text(p.customerName != null ? p.customerName : p.name) : current.customer_name;
  const phone = p.phone != null ? text(p.phone) : current.phone;
  if (!customerName && !phone) throw new Error("Lead name or phone is required");
  const email = p.email != null ? text(p.email) : current.email;
  const device = p.device != null ? text(p.device) : current.device;
  const issue = p.issue != null ? text(p.issue) : current.issue;
  const quotedAmount = p.quotedAmount != null || p.quoted_amount != null
    ? moneyFrom(p.quotedAmount != null ? p.quotedAmount : p.quoted_amount)
    : moneyFrom(current.quoted_amount);
  const source = p.source != null ? text(p.source) : current.source;
  const status = p.status != null ? statusFrom(p.status, current.status) : current.status;
  const followUpDate = p.followUpDate != null || p.follow_up_date != null
    ? dateFrom(p.followUpDate != null ? p.followUpDate : p.follow_up_date)
    : dateFrom(current.follow_up_date);
  const notes = p.notes != null ? text(p.notes) : current.notes;

  await sql`
    UPDATE leads
    SET customer_name = ${customerName},
        phone = ${phone},
        email = ${email},
        device = ${device},
        issue = ${issue},
        quoted_amount = ${quotedAmount},
        source = ${source},
        status = ${status},
        follow_up_date = ${followUpDate},
        notes = ${notes},
        updated_at = now()
    WHERE id = ${id}
  `;
  return getLead(id);
}

export async function deleteLead(p) {
  const id = text(p.id);
  if (!id) throw new Error("Lead ID is required");
  const rows = await sql`SELECT * FROM leads WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Lead not found: " + id);
  await sql`UPDATE leads SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  return id;
}
