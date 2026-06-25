import { neon } from "@neondatabase/serverless";

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
    })();
  }
  return schemaPromise;
}

/** @deprecated use ensureSchema */
export function ensurePaymentFields() {
  return ensureSchema();
}
