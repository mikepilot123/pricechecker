// A lasting record of saves that failed. Vercel's Hobby plan keeps logs for
// an hour, so without this a failed save left no trace. Two sources:
//   * "server": a save in /api/intake or /api/invoice threw (recorded by the
//     route's error handler);
//   * "client": the app never got an answer (offline, timeout, server
//     crash) and reported it once it could reach the server again.
// Each row keeps a copy of what was being saved, with the PIN and anything
// secret removed, so the data can be re-entered from it.
//
// Recording is best effort: if it fails too, the original error is what the
// caller reports — this never hides or replaces it.
import { sql, isReadOnlyDeployment } from "./db.js";

const SECRET_KEY = /pin|pass(word)?|secret|token|credential|api[-_]?key|authori[sz]ation|cookie|signature|private[-_]?key/i;
const MAX_STRING = 2000;      // longer values (e.g. a PDF as base64) are cut
const MAX_BODY_CHARS = 20000; // whole stored body
const MAX_ERROR = 1000;
const KEEP_DAYS = 180;

/** A copy of `value` with secret-looking keys removed and long strings cut. */
export function scrubForLog(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, 200)}… [${value.length - 200} more characters removed]` : value;
  }
  if (depth > 6) return "[nested too deep]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrubForLog(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[removed]" : scrubForLog(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function boundedBody(body) {
  const scrubbed = scrubForLog(body && typeof body === "object" ? body : {});
  const text = JSON.stringify(scrubbed);
  return text.length > MAX_BODY_CHARS
    ? JSON.stringify({ truncated: true, preview: text.slice(0, MAX_BODY_CHARS) })
    : text;
}

const errorText = (err) => String((err && (err.message || err)) || "Unknown error").slice(0, MAX_ERROR);

/**
 * Records one failed save. Never throws; returns true if it was recorded.
 */
export async function recordSaveFailure({ route, method, action, error, body, source = "server", deviceId = "" } = {}) {
  if (isReadOnlyDeployment()) return false; // a preview never writes
  try {
    await sql`
      INSERT INTO save_failures (route, method, action, source, error, body, device_id)
      VALUES (${String(route || "").slice(0, 100)}, ${String(method || "").slice(0, 10)}, ${String(action || "").slice(0, 100)},
              ${source === "client" ? "client" : "server"}, ${errorText(error)}, ${boundedBody(body)}::jsonb, ${String(deviceId || "").slice(0, 100)})
    `;
    // Keep the table small: drop entries older than KEEP_DAYS now and then.
    if (Math.random() < 0.05) {
      await sql`DELETE FROM save_failures WHERE created_at < now() - make_interval(days => ${KEEP_DAYS})`;
    }
    return true;
  } catch (recordErr) {
    console.error("Couldn't record a failed save:", recordErr?.message || recordErr, "— original error:", errorText(error));
    return false;
  }
}

export async function listSaveFailures({ limit = 100 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = await sql`
    SELECT id, created_at, route, method, action, source, error, body, device_id
    FROM save_failures ORDER BY created_at DESC LIMIT ${n}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.created_at).toISOString(),
    route: r.route,
    method: r.method,
    action: r.action,
    source: r.source,
    error: r.error,
    body: r.body,
    deviceId: r.device_id,
  }));
}

/** Actions that only read — a failure there isn't a lost save. */
export function isReadAction(action) {
  return /^(list|get|search|preview|check|view|load|find|ticketsVersion|partsCheckList|deviceAccess|accountSummary|bankAccountSummary|emailTemplate|emailDraft|readyEmailDraft|senders|zohoStatus|forTicket|checkinCandidate)/.test(String(action || ""));
}
