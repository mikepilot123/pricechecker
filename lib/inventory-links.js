import { sql } from "./db.js";
import { priceModelKey } from "./prices.js";

// Inventory ↔ price list links. The inventory lives in a Google Sheet and the
// prices in the sheet + price catalog, and their names rarely line up exactly
// ("13 Pro" vs "iPhone 13 Pro"), so staff link a part to the model and repair
// it supplies when they add it (Add item modal, assets/inventory.js). The
// Prices view then ticks that repair whenever the part is in stock.

export async function listInventoryLinks() {
  const rows = await sql`
    SELECT item_key, model_key, model_name, repair_type
    FROM inventory_price_links
    ORDER BY item_key ASC
  `;
  return rows.map((row) => ({
    itemKey: row.item_key,
    modelKey: row.model_key,
    model: row.model_name || "",
    repairType: row.repair_type,
  }));
}

export async function saveInventoryLink({ itemKey, model, repairType } = {}) {
  const key = String(itemKey || "").trim();
  const modelName = String(model || "").trim().replace(/\s+/g, " ");
  const repair = String(repairType || "").trim().replace(/\s+/g, " ");
  if (!key) throw new Error("Inventory item is required");
  if (!modelName) throw new Error("Choose the device this part is for");
  if (!repair) throw new Error("Choose the repair this part is used for");
  await sql`
    INSERT INTO inventory_price_links (item_key, model_key, model_name, repair_type)
    VALUES (${key}, ${priceModelKey(modelName)}, ${modelName}, ${repair})
    ON CONFLICT (item_key) DO UPDATE SET
      model_key = EXCLUDED.model_key,
      model_name = EXCLUDED.model_name,
      repair_type = EXCLUDED.repair_type,
      updated_at = now()
  `;
  return key;
}

export async function deleteInventoryLink({ itemKey } = {}) {
  const key = String(itemKey || "").trim();
  if (!key) throw new Error("Inventory item is required");
  await sql`DELETE FROM inventory_price_links WHERE item_key = ${key}`;
  return key;
}
