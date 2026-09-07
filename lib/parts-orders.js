import { sql } from "./db.js";
import { upsertCustomer } from "./customers.js";

const STATUSES = new Set(["ordered", "arrived", "backordered", "cancelled"]);
const PAYMENT_STATUSES = new Set(["pending", "collected"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function statusFrom(value, fallback = "ordered") {
  const status = text(value).toLowerCase() || fallback;
  return STATUSES.has(status) ? status : fallback;
}

function paymentStatusFrom(value, fallback = "pending") {
  const status = text(value).toLowerCase() || fallback;
  return PAYMENT_STATUSES.has(status) ? status : fallback;
}

function amountFrom(value) {
  const n = Number(value);
  if (!isFinite(n) || n < 0) throw new Error("Unit cost must be a valid non-negative number");
  return (Math.round(n * 100) / 100).toFixed(2);
}

function quantityFrom(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Quantity must be a whole number greater than zero");
  return n;
}

function timestampFrom(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error("Date is invalid");
  return d.toISOString();
}

function rowToPartsOrder(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    shipmentName: row.shipment_name || "",
    inventoryItemKey: row.inventory_item_key || null,
    inventoryItemLabel: row.inventory_item_label || "",
    inventoryStockedQuantity: row.inventory_stocked_quantity == null ? null : Number(row.inventory_stocked_quantity),
    inventoryStockedAt: row.inventory_stocked_at ? new Date(row.inventory_stocked_at).toISOString() : null,
    inventoryStockState: row.inventory_stock_state || "",
    vendor: row.vendor || "",
    part: row.part || "",
    quantity: row.quantity,
    unitCost: Number(row.unit_cost || 0),
    totalCost: Math.round(Number(row.unit_cost || 0) * row.quantity * 100) / 100,
    status: row.status || "ordered",
    paymentStatus: row.payment_status || "pending",
    orderedAt: row.ordered_at ? new Date(row.ordered_at).toISOString() : null,
    arrivedAt: row.arrived_at ? new Date(row.arrived_at).toISOString() : null,
    customerId: row.customer_id || null,
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    ticketId: row.ticket_id || null,
    source: row.source || "manual",
    sourceDocumentUrl: row.source_document_url || null,
    notes: row.notes || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function listPartsOrders() {
  const rows = await sql`
    SELECT * FROM parts_orders WHERE deleted_at IS NULL ORDER BY ordered_at DESC, created_at DESC
  `;
  return rows.map(rowToPartsOrder);
}

async function getPartsOrder(id) {
  const rows = await sql`SELECT * FROM parts_orders WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Parts order not found: " + id);
  return rowToPartsOrder(rows[0]);
}

export async function addPartsOrder(p) {
  const id = text(p.id) || "PO" + crypto.randomUUID();
  const part = text(p.part);
  if (!part) throw new Error("Part description is required");
  const batchId = text(p.batchId) || id;
  const quantity = quantityFrom(p.quantity ?? 1);
  const unitCost = amountFrom(p.unitCost ?? 0);
  const status = statusFrom(p.status);
  const orderedAt = timestampFrom(p.orderedAt) || new Date().toISOString();
  const arrivedAt = status === "arrived" ? (timestampFrom(p.arrivedAt) || new Date().toISOString()) : null;
  const customerName = text(p.customerName);
  const customerPhone = text(p.customerPhone);

  // Best-effort, same as tickets: a phone lets this order show up against the
  // shared customer directory too, but a missing one never blocks the save.
  const customerId = customerPhone
    ? await upsertCustomer({ customerName, phone: customerPhone }).catch(() => null)
    : null;

  const paymentStatus = paymentStatusFrom(p.paymentStatus);

  await sql`
    INSERT INTO parts_orders (id, batch_id, shipment_name, vendor, part, quantity, unit_cost, status, payment_status, ordered_at, arrived_at,
      customer_id, customer_name, customer_phone, ticket_id, source, source_document_url, notes)
    VALUES (${id}, ${batchId}, ${text(p.shipmentName)}, ${text(p.vendor)}, ${part}, ${quantity}, ${unitCost}, ${status}, ${paymentStatus}, ${orderedAt}, ${arrivedAt},
      ${customerId}, ${customerName}, ${customerPhone}, ${text(p.ticketId) || null}, ${text(p.source) || "manual"},
      ${text(p.sourceDocumentUrl) || null}, ${text(p.notes)})
    ON CONFLICT (id) DO NOTHING
  `;
  return getPartsOrder(id);
}

export async function updatePartsOrder(p) {
  const id = text(p.id);
  if (!id) throw new Error("Parts order ID is required");
  const rows = await sql`SELECT * FROM parts_orders WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Parts order not found: " + id);
  const current = rows[0];

  if (current.inventory_stock_state === "stocked") {
    if (p.ticketId && text(p.ticketId) !== text(current.ticket_id)) {
      throw new Error("This part is already in inventory and can't also be linked to a repair");
    }
    if (p.quantity != null && Number(p.quantity) !== Number(current.quantity)) {
      throw new Error("Quantity can't be changed after this part has been added to inventory");
    }
    if (p.status != null && statusFrom(p.status, current.status) !== "arrived") {
      throw new Error("A part added to inventory must stay marked arrived");
    }
  }

  const vendor = p.vendor != null ? text(p.vendor) : current.vendor;
  const part = p.part != null ? text(p.part) : current.part;
  if (!part) throw new Error("Part description is required");
  const quantity = p.quantity != null ? quantityFrom(p.quantity) : current.quantity;
  const unitCost = p.unitCost != null ? amountFrom(p.unitCost) : current.unit_cost;
  const status = p.status != null ? statusFrom(p.status, current.status) : current.status;
  // Stamp arrived_at the moment status flips to "arrived"; clear it if
  // reopened to any other status so it can't lie about a part being in.
  const wasArrived = current.status === "arrived";
  const arrivedAt = status === "arrived"
    ? (wasArrived ? current.arrived_at : new Date().toISOString())
    : null;
  const customerName = p.customerName != null ? text(p.customerName) : current.customer_name;
  const customerPhone = p.customerPhone != null ? text(p.customerPhone) : current.customer_phone;
  const customerId = customerPhone
    ? await upsertCustomer({ customerName, phone: customerPhone }).catch(() => current.customer_id)
    : current.customer_id;
  const ticketId = p.ticketId !== undefined ? (text(p.ticketId) || null) : current.ticket_id;
  const notes = p.notes != null ? text(p.notes) : current.notes;

  await sql`
    UPDATE parts_orders SET vendor = ${vendor}, part = ${part}, quantity = ${quantity}, unit_cost = ${unitCost},
      status = ${status}, arrived_at = ${arrivedAt}, customer_id = ${customerId}, customer_name = ${customerName},
      customer_phone = ${customerPhone}, ticket_id = ${ticketId}, notes = ${notes}, updated_at = now()
    WHERE id = ${id}
  `;
  return getPartsOrder(id);
}

export async function deletePartsOrder(p) {
  const id = text(p.id);
  if (!id) throw new Error("Parts order ID is required");
  await getPartsOrder(id);
  await sql`UPDATE parts_orders SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  return id;
}

export async function renamePartsShipment(p) {
  const batchId = text(p.batchId);
  if (!batchId) throw new Error("Shipment ID is required");
  const shipmentName = text(p.shipmentName);
  const rows = await sql`
    UPDATE parts_orders
    SET shipment_name = ${shipmentName}, updated_at = now()
    WHERE batch_id = ${batchId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) throw new Error("Shipment not found: " + batchId);
  return { batchId, shipmentName, updatedCount: rows.length };
}

// Applies to every part sharing a batch_id, same as renamePartsShipment —
// a standalone (non-PDF) part's batch_id is just its own id, so this works
// uniformly whether it's a single part or a multi-part shipment.
export async function setPartsShipmentPaymentStatus(p) {
  const batchId = text(p.batchId);
  if (!batchId) throw new Error("Shipment ID is required");
  const paymentStatus = paymentStatusFrom(p.paymentStatus, null);
  if (!paymentStatus) throw new Error("Payment status must be 'pending' or 'collected'");
  const rows = await sql`
    UPDATE parts_orders
    SET payment_status = ${paymentStatus}, updated_at = now()
    WHERE batch_id = ${batchId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) throw new Error("Shipment not found: " + batchId);
  return { batchId, paymentStatus, updatedCount: rows.length };
}

export async function claimPartsOrderForInventory(p) {
  const id = text(p.id || p.partsOrderId);
  if (!id) throw new Error("Parts order ID is required");
  const claimed = await sql`
    UPDATE parts_orders
    SET inventory_stock_state = 'processing', updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL AND ticket_id IS NULL AND status <> 'cancelled' AND inventory_stock_state = ''
    RETURNING *
  `;
  if (claimed.length) return { alreadyStocked: false, partsOrder: rowToPartsOrder(claimed[0]) };

  const rows = await sql`SELECT * FROM parts_orders WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Parts order not found: " + id);
  const current = rows[0];
  if (current.ticket_id) throw new Error("This part is already linked to a repair");
  if (current.status === "cancelled") throw new Error("A cancelled part order can't be added to inventory");
  if (current.inventory_stock_state === "stocked") {
    return { alreadyStocked: true, partsOrder: rowToPartsOrder(current) };
  }
  throw new Error("This part is already being added to inventory");
}

export async function completePartsOrderInventory(p) {
  const id = text(p.id || p.partsOrderId);
  const quantity = quantityFrom(p.quantity);
  const rows = await sql`
    UPDATE parts_orders
    SET inventory_item_key = ${text(p.itemKey)}, inventory_item_label = ${text(p.itemLabel)},
      inventory_stocked_quantity = ${quantity}, inventory_stocked_at = now(), inventory_stock_state = 'stocked',
      status = 'arrived', arrived_at = COALESCE(arrived_at, now()), updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL AND inventory_stock_state = 'processing'
    RETURNING *
  `;
  if (!rows.length) throw new Error("Parts order inventory claim was lost");
  return rowToPartsOrder(rows[0]);
}

export async function releasePartsOrderInventoryClaim(p) {
  const id = text(p.id || p.partsOrderId);
  if (!id) return;
  await sql`
    UPDATE parts_orders SET inventory_stock_state = '', updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL AND inventory_stock_state = 'processing'
  `;
}
