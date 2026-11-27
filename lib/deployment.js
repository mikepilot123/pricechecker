// Which database this deployment uses, and whether it may write to it.
// No database code here, so any API route can check it cheaply.
//
// Production (VERCEL_ENV=production) and local runs/tests (VERCEL_ENV unset)
// use DATABASE_URL (or POSTGRES_URL) and behave exactly as before.
//
// A Vercel preview or development deployment shares the live database unless
// it's given its own PREVIEW_DATABASE_URL, so without one it is READ-ONLY:
//   * every query runs in a Postgres READ ONLY transaction, so the database
//     itself refuses writes (lib/db.js);
//   * the API answers POST/PUT/PATCH/DELETE with 503 before doing anything
//     (blockWritesOnReadOnlyDeployment, called first in each api/ route);
//   * no schema change or backfill runs (ensureSchema in lib/db.js).
// With its own PREVIEW_DATABASE_URL a preview works normally against that
// separate database.

const primaryUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const previewUrl = () => process.env.PREVIEW_DATABASE_URL || "";
const vercelEnv = () => String(process.env.VERCEL_ENV || "").trim().toLowerCase();
const isNonProductionDeployment = () => vercelEnv() === "preview" || vercelEnv() === "development";
const hasOwnPreviewDatabase = () => !!previewUrl() && previewUrl() !== primaryUrl();

export const READ_ONLY_MESSAGE = "Preview deployments are read-only";

/** True on a preview/development deployment that would be using the live database. */
export function isReadOnlyDeployment() {
  return isNonProductionDeployment() && !hasOwnPreviewDatabase();
}

/** The connection string this deployment should use. */
export function databaseUrl() {
  return isNonProductionDeployment() && hasOwnPreviewDatabase() ? previewUrl() : primaryUrl();
}

/**
 * For each API route, right after the CORS preflight: on a read-only
 * deployment answers POST/PUT/PATCH/DELETE with 503 and returns true (the
 * caller stops there). Always false in production.
 */
export function blockWritesOnReadOnlyDeployment(req, res) {
  if (!isReadOnlyDeployment()) return false;
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  res.status(503).json({
    ok: false,
    error: `${READ_ONLY_MESSAGE} — this copy of the app shares the live database. Use the production app to make changes.`,
    previewReadOnly: true,
  });
  return true;
}
