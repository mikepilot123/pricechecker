import { ensureSchema } from "../lib/db.js";
import { addLead, deleteLead, listLeads, updateLead } from "../lib/leads.js";
import { applyCors, checkPin } from "../lib/security.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.method === "GET" ? (req.query || {}) : readBody(req);
  const denied = checkPin(req, body.pin);
  if (denied) {
    return res.status(denied.status).json({ ok: false, error: denied.error });
  }

  const action = body.action || "list";
  try {
    await ensureSchema();
    if (action === "list") {
      return res.status(200).json({ ok: true, leads: await listLeads({ includeDeleted: !!body.includeDeleted }) });
    }
    if (action === "add") {
      return res.status(200).json({ ok: true, lead: await addLead(body) });
    }
    if (action === "update") {
      return res.status(200).json({ ok: true, lead: await updateLead(body) });
    }
    if (action === "delete") {
      return res.status(200).json({ ok: true, deletedId: await deleteLead(body) });
    }
    return res.status(200).json({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

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
