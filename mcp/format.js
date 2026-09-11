export function clampLimit(limit, fallback = 15) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 40);
}

export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 4) return "••••";
  return "•••" + digits.slice(-4);
}

export function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function currency() {
  return process.env.INVOICE_CURRENCY || "TTD";
}

export function matchesQuery(haystack, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const parts = q.split(/\s+/).filter(Boolean);
  const text = String(haystack || "").toLowerCase();
  return parts.every((part) => text.includes(part));
}

export function summarizeInventoryItem(item) {
  return {
    key: item.key,
    device: item.device || item.item || "",
    part: item.item || "",
    section: item.section || "",
    quality: item.quality || "",
    quantity: item.quantity,
    notes: item.note || "",
    status: item.status || "",
  };
}

export function summarizePartsOrder(row) {
  const incoming = row.status !== "arrived" && row.status !== "cancelled" && row.inventoryStockState !== "stocked";
  return {
    id: row.id,
    batchId: row.batchId,
    shipmentName: row.shipmentName || "",
    vendor: row.vendor || "",
    part: row.part,
    quantity: row.quantity,
    unitCost: money(row.unitCost),
    totalCost: money(row.totalCost),
    currency: currency(),
    status: incoming && row.status === "ordered" ? "In Transit" : row.status,
    paymentStatus: row.paymentStatus,
    orderedAt: row.orderedAt,
    arrivedAt: row.arrivedAt,
    ticketId: row.ticketId || null,
    inventoryItemKey: row.inventoryItemKey || null,
    inventoryStockState: row.inventoryStockState || "",
    notes: row.notes || "",
  };
}

export function summarizeTicket(ticket) {
  return {
    id: ticket.id,
    device: ticket.device || "",
    issues: ticket.issues || ticket.issue || "",
    status: ticket.status || "",
    repairCost: money(ticket.repairCost),
    currency: currency(),
    technician: ticket.technician || "",
    customerName: ticket.customerName || ticket.client || "",
    phone: maskPhone(ticket.phone),
    created: ticket.created,
    updated: ticket.updated,
    repairDueDate: ticket.repairDueDate || "",
  };
}

export function summarizeCustomer(row) {
  return {
    id: row.id,
    name: row.name || "",
    phone: maskPhone(row.phone),
    ticketCount: row.ticketCount || 0,
    lastTicketAt: row.lastTicketAt,
  };
}

export function summarizePriceModel(model, repairType = "") {
  const entries = (model.entries || [])
    .filter((entry) => !repairType || matchesQuery(entry.type, repairType))
    .map((entry) => ({
      repairType: entry.type,
      price: money(entry.value),
      raw: entry.value || "",
      currency: currency(),
    }))
    .filter((entry) => entry.raw !== "");
  return {
    id: model.id,
    name: model.name,
    brand: model.brand || "",
    entries,
  };
}
