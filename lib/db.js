import { neon } from "@neondatabase/serverless";
import { PIXEL_SEED, PIXEL_BRAND } from "./price-seed.js";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or POSTGRES_URL must be set");
}

// Neon's HTTP-based driver — each query is a single fetch() call, so there's
// no connection pool to exhaust across the many short-lived serverless
// function invocations a low-traffic shop tool like this gets.
export const sql = neon(connectionString);

// Deploys can reach the API before a manual migration is run. Keep these
// additive migrations idempotent so new columns become available safely on
// the first request after deployment as well as through migrations/*.
let schemaPromise;
export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS repair_cost NUMERIC(12, 2)`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2)`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS technician TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_item_key TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_item_label TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_section TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_quantity_delta INTEGER NOT NULL DEFAULT 0`;
      // Pins the month a ticket was first marked "Picked Up" (completed), so
      // the monthly_sales ledger below always credits/adjusts the right
      // month even if a repair-cost correction happens much later. See
      // lib/tickets.js's "Monthly sales ledger" comment for the full design.
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sales_month_key TEXT`;
      // Powers the "order parts" reminder: set the moment a ticket enters
      // Waiting for Parts, cleared the moment it leaves. parts_ordered is a
      // staff-set flag (a sub-status of Waiting for Parts) that quiets the
      // reminder once parts have actually been ordered. See lib/tickets.js's
      // updateTicket() for the transition logic.
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS waiting_for_parts_since TIMESTAMPTZ`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS parts_ordered BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id BIGSERIAL PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          inventory_item_key TEXT NOT NULL,
          inventory_item_label TEXT NOT NULL DEFAULT '',
          inventory_section TEXT NOT NULL DEFAULT '',
          delta INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_inventory_movements_ticket ON inventory_movements (ticket_id, created_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS technicians (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_technicians_name ON technicians (lower(name))`;
      await sql`
        INSERT INTO technicians (id, name)
        VALUES
          ('TECH_LIANA', 'Liana'),
          ('TECH_MICHAEL', 'Michael'),
          ('TECH_MARCUS', 'Marcus')
        ON CONFLICT (name) DO NOTHING
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          customer_name TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          device TEXT NOT NULL DEFAULT '',
          issue TEXT NOT NULL DEFAULT '',
          quoted_amount NUMERIC(12, 2),
          source TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'New',
          follow_up_date DATE,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_leads_deleted_status ON leads (deleted_at, status)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (follow_up_date)`;
      // A lead used to hold a single free-text "notes" field, overwritten on
      // every edit. This is now a running log — one row per note — so a
      // lead's history isn't lost each time someone updates it.
      await sql`
        CREATE TABLE IF NOT EXISTS lead_notes (
          id BIGSERIAL PRIMARY KEY,
          lead_id TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes (lead_id, created_at DESC)`;
      // One-time backfill: carry each lead's old single notes field into the
      // log as its first entry, so nothing written before this feature
      // existed gets lost. Tracked with a dedicated column (rather than
      // "does lead_notes already have a row") and claimed via an UPDATE ...
      // RETURNING, which Postgres row-locks — safe against ensureSchema
      // running concurrently across multiple serverless cold starts, unlike
      // a NOT EXISTS check (two instances can both pass that check before
      // either commits, double-inserting the same note).
      await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS legacy_notes_migrated_at TIMESTAMPTZ`;
      const claimed = await sql`
        UPDATE leads
        SET legacy_notes_migrated_at = now()
        WHERE notes <> '' AND legacy_notes_migrated_at IS NULL
        RETURNING id, notes, updated_at
      `;
      for (const row of claimed) {
        await sql`INSERT INTO lead_notes (lead_id, note, created_at) VALUES (${row.id}, ${row.notes}, ${row.updated_at})`;
      }
      // Cleanup for the earlier NOT-EXISTS version of this migration, which
      // already let a couple of duplicate backfill notes through in
      // production before this fix — keeps the lowest id per exact
      // duplicate (lead_id, note, created_at), removing the rest.
      await sql`
        DELETE FROM lead_notes a
        USING lead_notes b
        WHERE a.lead_id = b.lead_id AND a.note = b.note AND a.created_at = b.created_at AND a.id > b.id
      `;
      // Some duplicate backfills can differ only by row id/timestamp while
      // still carrying the same note text for the same lead. Keep the newest
      // visible copy so the notes list and badge count match what staff see.
      await sql`
        DELETE FROM lead_notes old
        USING lead_notes keep
        WHERE old.lead_id = keep.lead_id
          AND btrim(old.note) = btrim(keep.note)
          AND (old.created_at < keep.created_at OR (old.created_at = keep.created_at AND old.id < keep.id))
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_leads_updated_at ON leads (updated_at DESC)`;
      // Durable month-over-month sales ledger — kept separate from the
      // tickets table so a soft-delete or "Clear all" never erases a past
      // month's recognized revenue. Revenue is credited only for tickets
      // that reach "Picked Up" (matching Completed Repairs), via
      // lib/tickets.js's updateTicket()/rebuildMonthlySales() — never by
      // blindly recomputing from every ticket regardless of status.
      await sql`
        CREATE TABLE IF NOT EXISTS monthly_sales (
          month_key TEXT PRIMARY KEY,
          total_sales NUMERIC(12, 2) NOT NULL DEFAULT 0,
          ticket_count INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS ticket_media (
          id BIGSERIAL PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          url TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'photo',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_ticket_media_ticket ON ticket_media (ticket_id, created_at DESC)`;
      // New ticket media uploads now go to Cloudflare R2 instead of Vercel
      // Blob (see lib/r2.js, api/media-upload.js). Existing rows default to
      // 'vercel_blob' since that's where those files already live; deleteMedia()
      // in lib/media.js reads this to know which storage API to call.
      await sql`ALTER TABLE ticket_media ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'vercel_blob'`;
      await sql`ALTER TABLE ticket_media ADD COLUMN IF NOT EXISTS storage_key TEXT`;
      await sql`
        CREATE TABLE IF NOT EXISTS custom_invoices (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          ticket_id TEXT NOT NULL DEFAULT '',
          customer_name TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          device TEXT NOT NULL DEFAULT '',
          issues TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          repair_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
          amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'TTD',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          emailed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_custom_invoices_ticket ON custom_invoices (ticket_id, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_custom_invoices_token ON custom_invoices (token)`;
      // Appointments used to live only in each device's localStorage, which
      // meant a booking made on the shop tablet was invisible on a phone and
      // one cleared browser lost the whole schedule. Now shared, like leads.
      await sql`
        CREATE TABLE IF NOT EXISTS appointments (
          id TEXT PRIMARY KEY,
          client TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          device TEXT NOT NULL DEFAULT '',
          issue TEXT NOT NULL DEFAULT '',
          technician TEXT NOT NULL DEFAULT '',
          date DATE NOT NULL,
          time TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'scheduled',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (deleted_at, date, time)`;
      // Same story for expenses — device-local before, shared now.
      await sql`
        CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          date DATE NOT NULL,
          category TEXT NOT NULL DEFAULT 'Other',
          vendor TEXT NOT NULL DEFAULT '',
          amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (deleted_at, date DESC)`;
      // Shared customer directory — see migrations/014_create_customers.sql
      // and lib/customers.js for how it's kept in sync with tickets.
      await sql`
        CREATE TABLE IF NOT EXISTS customers (
          id          TEXT PRIMARY KEY,
          phone_key   TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL DEFAULT '',
          phone       TEXT NOT NULL DEFAULT '',
          email       TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (lower(name))`;
      // Price catalog — see migrations/015_create_price_catalog.sql and
      // lib/prices.js. Layers over the published Google Sheet the Prices tab
      // reads, and backs the Settings price editor.
      await sql`
        CREATE TABLE IF NOT EXISTS price_models (
          id          TEXT PRIMARY KEY,
          model_key   TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL,
          brand       TEXT NOT NULL DEFAULT '',
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at  TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_price_models_sort ON price_models (sort_order, lower(name))`;
      await sql`
        CREATE TABLE IF NOT EXISTS price_entries (
          id          BIGSERIAL PRIMARY KEY,
          model_id    TEXT NOT NULL REFERENCES price_models (id) ON DELETE CASCADE,
          repair_type TEXT NOT NULL,
          value       TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (model_id, repair_type)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_price_entries_model ON price_entries (model_id)`;
      // Pixel prices ship as seed data because that tab was never wired into
      // the sheet CSV list the Prices tab reads. DO NOTHING on both conflicts:
      // once a price is edited in the app, or a model deleted, the seed must
      // never overwrite or resurrect it.
      for (let i = 0; i < PIXEL_SEED.length; i++) {
        const model = PIXEL_SEED[i];
        const key = model.name.trim().toLowerCase().replace(/\s+/g, " ");
        const id = "PM:" + key;
        await sql`
          INSERT INTO price_models (id, model_key, name, brand, sort_order)
          VALUES (${id}, ${key}, ${model.name}, ${PIXEL_BRAND}, ${i})
          ON CONFLICT (model_key) DO NOTHING
        `;
        for (const [repairType, value] of Object.entries(model.entries)) {
          await sql`
            INSERT INTO price_entries (model_id, repair_type, value)
            VALUES (${id}, ${repairType}, ${value})
            ON CONFLICT (model_id, repair_type) DO NOTHING
          `;
        }
      }
    })();
  }
  return schemaPromise;
}

/** @deprecated use ensureSchema */
export function ensurePaymentFields() {
  return ensureSchema();
}
