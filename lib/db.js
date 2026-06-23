import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL or POSTGRES_URL must be set");
}

// Neon's HTTP-based driver — each query is a single fetch() call, so there's
// no connection pool to exhaust across the many short-lived serverless
// function invocations a low-traffic shop tool like this gets.
export const sql = neon(connectionString);

// Deploys can reach the API before a manual migration is run. Keep this
// additive migration idempotent so payment fields become available safely on
// the first request after deployment as well as through migrations/002.
let paymentFieldsPromise;
export function ensurePaymentFields() {
  if (!paymentFieldsPromise) {
    paymentFieldsPromise = (async () => {
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS repair_cost NUMERIC(12, 2)`;
      await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2)`;
    })();
  }
  return paymentFieldsPromise;
}
