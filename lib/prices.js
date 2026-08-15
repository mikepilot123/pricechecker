import { sql } from "./db.js";

// The price catalog: the app's own store for repair prices, layered on top of
// the published Google Sheet that assets/app.js still reads as the base list.
//
// Precedence, applied client-side in assets/app.js's mergePriceOverrides():
//   1. sheet CSV rows                        (base)
//   2. price_entries rows for the same model (override / add a repair type)
//   3. price_models.deleted_at              (hide the model entirely)
//
// A model that only exists here (Pixel, say) is simply appended. This is what
// lets the Settings price editor be the only place staff ever need to touch,
// without a risky one-shot migration of the ~100 models already in the sheet.

/** Matching key for a model name — the join between sheet rows and DB rows. */
export function priceModelKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Derived straight from the (unique) model key so it's stable and collision
// free. Deriving it by squashing punctuation instead would let "Pixel 7 A"
// and "Pixel 7-A" — two distinct keys — land on the same primary key.
function priceModelId(key) {
  return "PM:" + key;
}

export async function listPriceModels() {
  const models = await sql`
    SELECT id, model_key, name, brand, sort_order, deleted_at, updated_at
    FROM price_models
    ORDER BY sort_order ASC, lower(name) ASC
  `;
  const entries = await sql`SELECT model_id, repair_type, value FROM price_entries ORDER BY id ASC`;

  const byModel = new Map();
  for (const entry of entries) {
    if (!byModel.has(entry.model_id)) byModel.set(entry.model_id, []);
    byModel.get(entry.model_id).push({ type: entry.repair_type, value: entry.value || "" });
  }

  return models.map((model) => ({
    id: model.id,
    key: model.model_key,
    name: model.name,
    brand: model.brand || "",
    sortOrder: model.sort_order || 0,
    deleted: !!model.deleted_at,
    updated: model.updated_at ? new Date(model.updated_at).toISOString() : null,
    entries: byModel.get(model.id) || [],
  }));
}

/**
 * Upserts a batch of models and their prices — the Settings editor sends only
 * what actually changed, so this stays a short list even for a bulk edit.
 *
 * An entry saved as "" is stored rather than deleted: for a sheet-backed model
 * that's the only way to express "hide the sheet's value for this repair",
 * which the merge step honours by dropping the row.
 */
export async function savePriceModels({ models } = {}) {
  const list = Array.isArray(models) ? models : [];
  const saved = [];

  for (const raw of list) {
    const name = String((raw && raw.name) || "").trim();
    if (!name) continue;
    const key = priceModelKey(name);
    const id = priceModelId(key);
    const brand = String((raw && raw.brand) || "").trim();
    const deletedAt = raw && raw.deleted ? new Date().toISOString() : null;
    const sortOrder = Number.isFinite(Number(raw && raw.sortOrder)) ? Number(raw.sortOrder) : 0;

    await sql`
      INSERT INTO price_models (id, model_key, name, brand, sort_order, deleted_at)
      VALUES (${id}, ${key}, ${name}, ${brand}, ${sortOrder}, ${deletedAt})
      ON CONFLICT (model_key) DO UPDATE SET
        name = EXCLUDED.name,
        brand = CASE WHEN EXCLUDED.brand <> '' THEN EXCLUDED.brand ELSE price_models.brand END,
        deleted_at = EXCLUDED.deleted_at,
        updated_at = now()
    `;

    const entries = Array.isArray(raw && raw.entries) ? raw.entries : [];
    for (const entry of entries) {
      const type = String((entry && entry.type) || "").trim();
      if (!type) continue;
      const value = String(entry && entry.value != null ? entry.value : "").trim();
      await sql`
        INSERT INTO price_entries (model_id, repair_type, value)
        VALUES (${id}, ${type}, ${value})
        ON CONFLICT (model_id, repair_type) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = now()
      `;
    }
    saved.push(id);
  }

  return { saved: saved.length, ids: saved };
}

/**
 * Soft-deletes a model so it disappears from the Prices tab. Soft rather than
 * hard because the model may be a sheet row: the CSV would just re-add it on
 * the next sync, so the tombstone has to survive to keep suppressing it.
 */
export async function deletePriceModel({ id, name } = {}) {
  const targetId = String(id || "").trim() || priceModelId(priceModelKey(name));
  if (!targetId || targetId === "PM:") throw new Error("id or name is required");

  // A sheet-only model has no row yet — insert the tombstone so deleting a
  // model that was never edited in-app still hides it.
  const key = targetId.startsWith("PM:") ? targetId.slice(3) : priceModelKey(name);
  await sql`
    INSERT INTO price_models (id, model_key, name, brand, deleted_at)
    VALUES (${targetId}, ${key}, ${String(name || key)}, '', now())
    ON CONFLICT (model_key) DO UPDATE SET deleted_at = now(), updated_at = now()
  `;
  return targetId;
}

/** Restores a soft-deleted model. */
export async function restorePriceModel({ id, name } = {}) {
  const targetId = String(id || "").trim() || priceModelId(priceModelKey(name));
  if (!targetId || targetId === "PM:") throw new Error("id or name is required");
  await sql`UPDATE price_models SET deleted_at = NULL, updated_at = now() WHERE id = ${targetId}`;
  return targetId;
}
