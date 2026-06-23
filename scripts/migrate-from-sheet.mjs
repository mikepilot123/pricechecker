#!/usr/bin/env node
// One-off import: pulls every ticket out of the live Google Sheet (via the
// existing, unmodified Apps Script doGet?action=list) and seeds the new
// Postgres database. Read-only against the sheet — safe to re-run.
//
// Usage:
//   GAS_SCRIPT_URL=https://script.google.com/macros/s/.../exec \
//   GAS_PIN=1234 \
//   DATABASE_URL=postgres://... \
//   node scripts/migrate-from-sheet.mjs [--upsert]
//
// Without --upsert, tickets whose id already exists in the database are
// skipped (safe to dry-run first). With --upsert, existing rows are
// refreshed from the sheet instead.

import { neon } from "@neondatabase/serverless";

const GAS_URL = process.env.GAS_SCRIPT_URL;
const GAS_PIN = process.env.GAS_PIN || process.env.INTAKE_PIN;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const UPSERT = process.argv.includes("--upsert");

if (!GAS_URL || !GAS_PIN || !DATABASE_URL) {
  console.error("Set GAS_SCRIPT_URL, GAS_PIN, and DATABASE_URL env vars before running.");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function main() {
  const url = `${GAS_URL}?action=list&pin=${encodeURIComponent(GAS_PIN)}&_=${Date.now()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error("Sheet list failed: " + data.error);
  const tickets = data.tickets || [];
  console.log(`Fetched ${tickets.length} tickets from the Google Sheet.`);

  let imported = 0;
  let skipped = 0;

  for (const t of tickets) {
    const existing = await sql`SELECT id FROM tickets WHERE id = ${t.id}`;
    if (existing.length && !UPSERT) {
      skipped++;
      continue;
    }

    const customerName = t.customerName || t.client || "";
    const issues = t.issues || t.issue || "";
    const phone = t.phone || "";
    const email = t.email || "";
    const device = t.device || "";
    const status = t.status || "Received";
    const notes = t.notes || "";
    const createdAt = t.created || new Date().toISOString();
    const updatedAt = t.updated || createdAt;

    await sql`
      INSERT INTO tickets (id, customer_name, phone, email, device, issues, status, notes, created_at, updated_at, deleted_at, current_version)
      VALUES (${t.id}, ${customerName}, ${phone}, ${email}, ${device}, ${issues}, ${status}, ${notes}, ${createdAt}, ${updatedAt}, NULL, 1)
      ON CONFLICT (id) DO UPDATE SET
        customer_name = EXCLUDED.customer_name, phone = EXCLUDED.phone, email = EXCLUDED.email, device = EXCLUDED.device,
        issues = EXCLUDED.issues, status = EXCLUDED.status, notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at
    `;

    // Re-runnable: drop any prior "import" snapshot for this ticket before
    // writing a fresh one, rather than accumulating duplicates on --upsert.
    await sql`DELETE FROM ticket_versions WHERE ticket_id = ${t.id} AND change_type = 'import'`;
    await sql`
      INSERT INTO ticket_versions (ticket_id, version_number, snapshot, change_summary, change_type, created_at)
      VALUES (
        ${t.id}, 1,
        ${JSON.stringify({ customerName, phone, email, device, issues, status, notes, importedHistoryText: t.history || "" })}::jsonb,
        'Imported from Google Sheet', 'import', now()
      )
    `;
    imported++;
  }

  console.log(
    `Done: ${imported} ticket(s) imported/refreshed, ${skipped} skipped (already existed — pass --upsert to refresh them).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
