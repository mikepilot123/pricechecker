import { adjustInventoryItem, listInventory } from "../lib/inventory.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    if (req.method === "POST") {
      const body = readBody(req);
      if (!process.env.INTAKE_PIN || String(body.pin) !== String(process.env.INTAKE_PIN)) {
        return res.status(200).json({ ok: false, error: "Invalid PIN" });
      }
      if (body.action !== "adjust") {
        return res.status(200).json({ ok: false, error: "Unknown action: " + (body.action || "") });
      }
      const delta = Number(body.delta);
      if (!Number.isInteger(delta) || delta === 0) {
        return res.status(200).json({ ok: false, error: "Inventory adjustment must be a non-zero whole number" });
      }
      const movement = await adjustInventoryItem(String(body.itemKey || ""), delta, {
        reason: "Manual inventory update",
      });
      const inventory = await listInventory();
      return res.status(200).json({ ok: true, movement, ...inventory });
    }

    const inventory = await listInventory();
    return res.status(200).json({ ok: true, ...inventory });
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
