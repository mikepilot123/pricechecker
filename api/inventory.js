import { addInventoryItem, adjustInventoryItem, listInventory } from "../lib/inventory.js";
import { ensureSchema } from "../lib/db.js";
import {
  claimPartsOrderForInventory,
  completePartsOrderInventory,
  releasePartsOrderInventoryClaim,
} from "../lib/parts-orders.js";
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
      if (body.action === "stockPartsOrder") {
        await ensureSchema();
        const partsOrderId = String(body.partsOrderId || "").trim();
        const claim = await claimPartsOrderForInventory({ partsOrderId });
        if (claim.alreadyStocked) {
          return res.status(200).json({ ok: true, alreadyStocked: true, partsOrder: claim.partsOrder, ...await listInventory() });
        }
        try {
          const quantity = claim.partsOrder.quantity;
          let inventory;
          let itemKey = String(body.itemKey || "").trim();
          let itemLabel = "";
          let movement = null;
          if (itemKey) {
            movement = await adjustInventoryItem(itemKey, quantity, { reason: `Parts order ${partsOrderId}` });
            itemLabel = movement.label;
            inventory = await listInventory();
          } else {
            const section = String(body.section || "").trim();
            const item = String(body.item || "").trim();
            const quality = String(body.quality || "").trim();
            inventory = await addInventoryItem({ section, item, quality, quantity });
            const created = inventory.items.find((candidate) =>
              candidate.section === section.toUpperCase() &&
              candidate.item.toLowerCase() === item.toLowerCase() &&
              String(candidate.quality || "").toLowerCase() === quality.toLowerCase());
            if (!created) throw new Error("The inventory item was added but couldn't be linked back to this order");
            itemKey = created.key;
            itemLabel = created.label;
          }
          const partsOrder = await completePartsOrderInventory({
            partsOrderId, itemKey, itemLabel, quantity,
          });
          return res.status(200).json({ ok: true, movement, partsOrder, ...inventory });
        } catch (err) {
          await releasePartsOrderInventoryClaim({ partsOrderId });
          throw err;
        }
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
