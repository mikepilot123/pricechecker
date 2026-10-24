-- Links an inventory sheet row to the price list entry it supplies, so the
-- Prices view can show a green tick by a model's repair when that part is in
-- stock (assets/app.js's isPricePartInStock) — even when the sheet's item
-- name doesn't spell the model exactly like the price list does.
--
-- item_key is the inventory key from lib/inventory.js (section|item|quality,
-- lowercased); model_key is lib/prices.js's priceModelKey() of the model name.
-- Set from the Add item modal (assets/inventory.js); see
-- lib/inventory-links.js.
--
-- Mirrored idempotently in lib/db.js's ensureSchema().
CREATE TABLE IF NOT EXISTS inventory_price_links (
  item_key     TEXT PRIMARY KEY,
  model_key    TEXT NOT NULL,
  model_name   TEXT NOT NULL DEFAULT '',
  repair_type  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_price_links_model ON inventory_price_links (model_key);
