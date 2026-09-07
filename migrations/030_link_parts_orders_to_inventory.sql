-- Records when an ordered part is received into the live inventory sheet.
-- inventory_stock_state is a small idempotency claim: only one request may
-- move a line from '' -> processing -> stocked, preventing double additions.
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS inventory_item_key TEXT;
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS inventory_item_label TEXT NOT NULL DEFAULT '';
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS inventory_stocked_quantity INTEGER;
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS inventory_stocked_at TIMESTAMPTZ;
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS inventory_stock_state TEXT NOT NULL DEFAULT '';
