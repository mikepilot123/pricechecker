import { ensureSchema } from "../lib/db.js";
import { addLead, deleteLead, listLeads, updateLead } from "../lib/leads.js";

export default async function handler(req, res) {
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
