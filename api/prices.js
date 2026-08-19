import {
  listPriceModels,
  savePriceModels,
  deletePriceModel,
  restorePriceModel,
  listCommonSearches,
  saveCommonSearch,
  recordCommonSearchUse,
  renameCommonSearch,
  deleteCommonSearch,
} from "../lib/prices.js";
import { ensureSchema } from "../lib/db.js";
import { applyCors, checkPin } from "../lib/security.js";

// Reads are public, writes are PIN-gated — same split as api/inventory.js.
// Prices aren't sensitive (the base list is a Google Sheet literally published
// to the web), and the Prices tab has to render them on devices that have
// never entered the intake PIN.
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await ensureSchema();

    if (req.method === "GET") {
      const [models, commonSearches] = await Promise.all([listPriceModels(), listCommonSearches()]);
      return res.status(200).json({ ok: true, models, commonSearches });
    }

    const body = readBody(req);
    if (body.action === "recordCommonSearchUse" || body.action === "trackPriceSearch") {
      await recordCommonSearchUse(body);
      return res.status(200).json({ ok: true, commonSearches: await listCommonSearches() });
    }

    const denied = checkPin(req, body.pin);
    if (denied) {
      return res.status(denied.status).json({ ok: false, error: denied.error });
    }

    if (body.action === "save") {
      const { saved } = await savePriceModels(body);
      return res.status(200).json({ ok: true, saved, models: await listPriceModels() });
    }
    if (body.action === "delete") {
      const deletedId = await deletePriceModel(body);
      return res.status(200).json({ ok: true, deletedId, models: await listPriceModels() });
    }
    if (body.action === "restore") {
      const restoredId = await restorePriceModel(body);
      return res.status(200).json({ ok: true, restoredId, models: await listPriceModels() });
    }
    if (body.action === "saveCommonSearch") {
      const savedId = await saveCommonSearch(body);
      return res.status(200).json({ ok: true, savedId, commonSearches: await listCommonSearches() });
    }
    if (body.action === "renameCommonSearch") {
      const savedId = await renameCommonSearch(body);
      return res.status(200).json({ ok: true, savedId, commonSearches: await listCommonSearches() });
    }
    if (body.action === "deleteCommonSearch") {
      const deletedId = await deleteCommonSearch(body);
      return res.status(200).json({ ok: true, deletedId, commonSearches: await listCommonSearches() });
    }
    return res.status(200).json({ ok: false, error: "Unknown action: " + (body.action || "") });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// assets/* posts with Content-Type: text/plain to dodge a CORS preflight, so
// Vercel hands us the raw string instead of a parsed object.
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
