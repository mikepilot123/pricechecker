-- A user-editable name for a PDF-imported shipment. It is repeated on each
-- line item in the batch so the existing flat parts_orders model remains
-- intact; renamePartsShipment updates the batch atomically.
ALTER TABLE parts_orders
  ADD COLUMN IF NOT EXISTS shipment_name TEXT NOT NULL DEFAULT '';
