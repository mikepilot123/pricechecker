import { addInventoryItem, adjustInventoryItem, listInventory } from "../lib/inventory.js";
import { applyCors, checkPin } from "../lib/security.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    if (req.method === "POST") {
      const body = readBody(req);
      const denied = checkPin(req, body.pin);
      if (denied) {
        return res.status(denied.status).json({ ok: false, error: denied.error });
      }
      if (body.action === "addItem") {
        const inventory = await addInventoryItem({
          section: body.section, item: body.item, quality: body.quality, quantity: body.quantity,
        });
        return res.status(200).json({ ok: true, ...inventory });
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
