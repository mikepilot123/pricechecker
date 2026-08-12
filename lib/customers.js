import { sql } from "./db.js";

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// Keeps the shared customer directory in sync with whatever a ticket's
// intake/edit form last had for name/phone/email. Phone is the match key —
// no phone, no reliable way to dedupe, so those tickets just don't get a
// directory entry. Non-fatal by design: callers (lib/tickets.js) await this
// but swallow failures, since the directory is secondary to the ticket
// itself actually saving.
export async function upsertCustomerFromTicket({ customerName, phone, email }) {
  const phoneKey = normalizePhone(phone);
  if (!phoneKey) return null;
  const id = "CUST" + phoneKey;
  const name = String(customerName || "").trim();
  const rows = await sql`
    INSERT INTO customers (id, phone_key, name, phone, email)
    VALUES (${id}, ${phoneKey}, ${name}, ${phone || ""}, ${email || ""})
    ON CONFLICT (phone_key) DO UPDATE SET
      name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE customers.name END,
      phone = EXCLUDED.phone,
      email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE customers.email END,
      updated_at = now()
    RETURNING id
  `;
  return rows[0]?.id || id;
}

// Device counts and last-visit dates are joined from tickets at read time
// (rather than a counter column on customers) so they can never drift out of
// sync with reality — deletes, restores, and edits all just work.
export async function listCustomers() {
  const rows = await sql`
    SELECT
      c.id, c.name, c.phone, c.email, c.created_at, c.updated_at,
      COALESCE(t.ticket_count, 0)::int AS ticket_count,
      t.last_ticket_at
    FROM customers c
    LEFT JOIN (
      SELECT regexp_replace(phone, '\D', '', 'g') AS phone_key,
        COUNT(*) AS ticket_count,
        MAX(created_at) AS last_ticket_at
      FROM tickets
      WHERE deleted_at IS NULL
      GROUP BY regexp_replace(phone, '\D', '', 'g')
    ) t ON t.phone_key = c.phone_key
    ORDER BY lower(c.name) ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name || "",
    phone: row.phone || "",
    email: row.email || "",
    ticketCount: row.ticket_count || 0,
    lastTicketAt: row.last_ticket_at ? new Date(row.last_ticket_at).toISOString() : null,
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}
