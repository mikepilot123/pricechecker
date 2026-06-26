-- Inventory item consumed by a repair ticket. Stored on the ticket so deletes
-- can restock the exact item that was deducted on check-in.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_item_key TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_item_label TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_section TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inventory_quantity_delta INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  inventory_item_key TEXT NOT NULL,
  inventory_item_label TEXT NOT NULL DEFAULT '',
  inventory_section TEXT NOT NULL DEFAULT '',
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_ticket ON inventory_movements (ticket_id, created_at DESC);
