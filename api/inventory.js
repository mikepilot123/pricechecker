import { addInventoryItem, adjustInventoryItem, inventoryKey, listInventory, stockPartsOrderToInventory } from "../lib/inventory.js";
import { deleteInventoryLink, listInventoryLinks, saveInventoryLink } from "../lib/inventory-links.js";
import { ensureSchema } from "../lib/db.js";
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
        const link = body.link && typeof body.link === "object" ? body.link : null;
        if (link && (!String(link.model || "").trim() || !String(link.repairType || "").trim())) {
          return res.status(200).json({ ok: false, error: "Choose both the device and the repair to link this part to" });
        }
        const inventory = await addInventoryItem({
          section: body.section, item: body.item, quality: body.quality, quantity: body.quantity,
        });
        // The row is already in the sheet by now, so a failed link is
        // reported alongside the success rather than as a failed add.
        let linkError = "";
        if (link) {
          try {
            await ensureSchema();
            await saveInventoryLink({
              itemKey: inventoryKey(String(body.section || "").toUpperCase(), body.item, body.quality),
              model: link.model,
              repairType: link.repairType,
            });
          } catch (err) {
            linkError = String((err && err.message) || err);
          }
        }
        return res.status(200).json({ ok: true, ...inventory, links: await linksOrEmpty(), linkError });
      }
      if (body.action === "linkItem" || body.action === "unlinkItem") {
        await ensureSchema();
        if (body.action === "linkItem") {
          await saveInventoryLink({ itemKey: body.itemKey, model: body.model, repairType: body.repairType });
        } else {
          await deleteInventoryLink({ itemKey: body.itemKey });
        }
        const inventory = await listInventory();
        return res.status(200).json({ ok: true, ...inventory, links: await linksOrEmpty() });
      }
      if (body.action === "stockPartsOrder") {
        await ensureSchema();
        const result = await stockPartsOrderToInventory({
          partsOrderId: body.partsOrderId,
          itemKey: body.itemKey,
          section: body.section,
          item: body.item,
          quality: body.quality,
        });
        return res.status(200).json({ ok: true, ...result, links: await linksOrEmpty() });
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
      return res.status(200).json({ ok: true, movement, ...inventory, links: await linksOrEmpty() });
    }

    const [inventory, links] = await Promise.all([listInventory(), linksOrEmpty()]);
    return res.status(200).json({ ok: true, ...inventory, links });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// Links only add the price list's stock ticks, so the inventory itself still
// loads if the database is unreachable.
async function linksOrEmpty() {
  try {
    await ensureSchema();
    return await listInventoryLinks();
  } catch (err) {
    console.error("Couldn't load inventory price links:", err);
    return [];
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
