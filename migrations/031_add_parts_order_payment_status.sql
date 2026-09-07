-- Tracks whether the shop has paid the supplier for an ordered shipment —
-- independent of the part's own ordered/arrived/cancelled status. Set at the
-- shipment level (every part sharing a batch_id, same as shipment_name) via
-- lib/parts-orders.js's setPartsShipmentPaymentStatus.
ALTER TABLE parts_orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
