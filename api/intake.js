import {
  listTickets,
  addTicket,
  updateTicket,
  deleteTicket,
  clearAll,
  listBackups,
  restoreBackup,
} from "../lib/tickets.js";

// Mirrors apps-script/Code.gs's handle(p) dispatch-by-action shape exactly,
// so assets/intake.js needs no changes beyond pointing SCRIPT_URL at this
// endpoint: same { action, pin, ...fields } request shape, same { ok, ... }
// response shape. Two new actions (listBackups, restoreBackup) are additive —
// the current frontend doesn't call them yet, they're for the Settings
// version-history UI.
export default async function handler(req, res) {
  // The frontend (GitHub Pages) is cross-origin from this Vercel deployment.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "GET" ? (req.query || {}) : readBody(req);

  if (String(body.pin) !== String(process.env.INTAKE_PIN)) {
    return res.status(200).json({ ok: false, error: "Invalid PIN" });
  }

  const action = body.action || "list";
  try {
    if (action === "list") {
      return res.status(200).json({ ok: true, tickets: await listTickets({ includeDeleted: !!body.includeDeleted }) });
    }
    if (action === "add") {
      return res.status(200).json({ ok: true, ticket: await addTicket(body) });
    }
    if (action === "update") {
      return res.status(200).json({ ok: true, ticket: await updateTicket(body) });
    }
    if (action === "delete") {
      return res.status(200).json({ ok: true, deletedId: await deleteTicket(body) });
    }
    if (action === "clear") {
      const { deletedCount, backup } = await clearAll();
      return res.status(200).json({ ok: true, deletedCount, backup });
    }
    if (action === "listBackups") {
      return res.status(200).json({ ok: true, backups: await listBackups() });
    }
    if (action === "restoreBackup") {
      const { restoredCount, backup, tickets } = await restoreBackup(body);
      return res.status(200).json({ ok: true, restoredCount, backup, tickets });
    }
    return res.status(200).json({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// assets/intake.js posts with Content-Type: text/plain (to dodge a CORS
// preflight), so Vercel's automatic body parser hands us a raw string here
// instead of a parsed object — parse it ourselves, same as Code.gs's doPost
// already had to.
function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}
