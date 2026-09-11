import { z } from "zod";
import { ensureSchema } from "../lib/db.js";
import {
  addInventoryItem,
  adjustInventoryItem,
  listInventory,
  stockPartsOrderToInventory,
} from "../lib/inventory.js";
import {
  addPartsOrder,
  getPartsOrder,
  searchPartsOrders,
  updatePartsOrder,
} from "../lib/parts-orders.js";
import {
  addTicket,
  getTicketById,
  searchTickets,
  TICKET_STATUSES,
  updateTicket,
} from "../lib/tickets.js";
import { getCustomerById, searchCustomers } from "../lib/customers.js";
import { listPriceModels } from "../lib/prices.js";
import { fail, ok, runTool } from "./errors.js";
import { logMcp } from "./logging.js";
import {
  clampLimit,
  currency,
  matchesQuery,
  money,
  summarizeCustomer,
  summarizeInventoryItem,
  summarizePartsOrder,
  summarizePriceModel,
  summarizeTicket,
} from "./format.js";

const limitSchema = z.number().int().min(1).max(40).optional();

function writeLog(actor, tool, recordId, result) {
  const payload = result?.structuredContent || {};
  logMcp({
    actor,
    tool,
    recordId: recordId || payload.id || payload.partsOrder?.id || null,
    write: true,
    ok: payload.ok !== false && !result?.isError,
    error: payload.error || null,
  });
}

function findInventoryItem(inventory, { itemKey, query }) {
  const items = inventory.items || [];
  if (itemKey) {
    return items.find((item) => item.key === itemKey) || null;
  }
  const matches = items.filter((item) =>
    matchesQuery([item.item, item.quality, item.section, item.note, item.label].join(" "), query)
  );
  return matches.length === 1 ? matches[0] : { matches };
}

export function registerTools(server, { actor = "mcp-connector" } = {}) {
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("search_inventory", {
    title: "Search inventory",
    description: "Search shop stock in the inventory sheet by device, part, section, or quality. Use for questions like whether a Pixel 7 battery is in stock.",
    inputSchema: { query: z.string().min(1), section: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ query, section, limit }) => runTool("search_inventory", async () => {
    const inventory = await listInventory();
    const sectionFilter = String(section || "").trim().toUpperCase();
    const items = (inventory.items || [])
      .filter((item) => !sectionFilter || item.section === sectionFilter)
      .filter((item) => matchesQuery([item.item, item.quality, item.section, item.note, item.label].join(" "), query))
      .slice(0, clampLimit(limit))
      .map(summarizeInventoryItem);
    return ok({ count: items.length, items });
  }));

  server.registerTool("get_inventory_item", {
    title: "Get inventory item",
    description: "Fetch one inventory item by its key, or by a unique search query.",
    inputSchema: { itemKey: z.string().optional(), query: z.string().optional() },
    annotations: read,
  }, async ({ itemKey, query }) => runTool("get_inventory_item", async () => {
    if (!itemKey && !query) return fail("invalid_input", "itemKey or query is required");
    const inventory = await listInventory();
    const found = findInventoryItem(inventory, { itemKey, query });
    if (!found) return fail("item_not_found", "Inventory item not found");
    if (found.matches) {
      if (!found.matches.length) return fail("item_not_found", "Inventory item not found");
      if (found.matches.length > 1) {
        return ok({
          multiple: true,
          items: found.matches.slice(0, 10).map(summarizeInventoryItem),
        }, "Multiple inventory items matched; pass itemKey to pick one.");
      }
      return ok({ item: summarizeInventoryItem(found.matches[0]) });
    }
    return ok({ item: summarizeInventoryItem(found) });
  }));

  server.registerTool("get_incoming_parts", {
    title: "Get incoming parts",
    description: "List supplier parts that have been ordered but not marked arrived/received and not yet added to inventory.",
    inputSchema: { query: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ query, limit }) => runTool("get_incoming_parts", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query: query || "", unreceivedOnly: true, limit: clampLimit(limit, 25) });
    return ok({ count: rows.length, items: rows.map(summarizePartsOrder) });
  }));

  server.registerTool("search_orders", {
    title: "Search supplier orders",
    description: "Search parts orders by part name, vendor, shipment name, or status. Use for recent orders and supplier purchase history.",
    inputSchema: {
      query: z.string().optional(),
      vendor: z.string().optional(),
      status: z.enum(["ordered", "arrived", "backordered", "cancelled"]).optional(),
      limit: limitSchema,
    },
    annotations: read,
  }, async ({ query, vendor, status, limit }) => runTool("search_orders", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query: query || "", vendor: vendor || "", status: status || "", limit: clampLimit(limit) });
    return ok({ count: rows.length, orders: rows.map(summarizePartsOrder) });
  }));

  server.registerTool("get_order", {
    title: "Get supplier order",
    description: "Fetch one parts-order row by id.",
    inputSchema: { id: z.string().min(1) },
    annotations: read,
  }, async ({ id }) => runTool("get_order", async () => {
    await ensureSchema();
    return ok({ order: summarizePartsOrder(await getPartsOrder(id)) });
  }));

  server.registerTool("get_recent_orders", {
    title: "Get recent orders",
    description: "List the most recently ordered supplier parts.",
    inputSchema: { limit: limitSchema, query: z.string().optional() },
    annotations: read,
  }, async ({ limit, query }) => runTool("get_recent_orders", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query: query || "", limit: clampLimit(limit, 10) });
    return ok({ count: rows.length, orders: rows.map(summarizePartsOrder) });
  }));

  server.registerTool("get_unreceived_order_items", {
    title: "Get unreceived order items",
    description: "Same as get_incoming_parts: supplier order lines not yet received into the shop.",
    inputSchema: { query: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ query, limit }) => runTool("get_unreceived_order_items", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query: query || "", unreceivedOnly: true, limit: clampLimit(limit, 25) });
    return ok({ count: rows.length, items: rows.map(summarizePartsOrder) });
  }));

  server.registerTool("search_supplier_parts", {
    title: "Search supplier parts",
    description: "Find supplier part lines and their unit costs. Use when asking which supplier a screen was bought from.",
    inputSchema: { query: z.string().min(1), vendor: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ query, vendor, limit }) => runTool("search_supplier_parts", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query, vendor: vendor || "", limit: clampLimit(limit) });
    return ok({ count: rows.length, parts: rows.map(summarizePartsOrder) });
  }));

  server.registerTool("get_supplier_cost", {
    title: "Get supplier cost",
    description: "Return the latest unit cost for a part, optionally from a specific vendor.",
    inputSchema: { query: z.string().min(1), vendor: z.string().optional() },
    annotations: read,
  }, async ({ query, vendor }) => runTool("get_supplier_cost", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query, vendor: vendor || "", limit: 1 });
    if (!rows.length) return fail("item_not_found", "No matching supplier purchase found");
    const order = summarizePartsOrder(rows[0]);
    return ok({
      part: order.part,
      vendor: order.vendor,
      cost: order.unitCost,
      currency: order.currency,
      orderedAt: order.orderedAt,
      orderId: order.id,
    });
  }));

  server.registerTool("get_previous_purchase_cost", {
    title: "Get previous purchase cost",
    description: "Return recent historical unit costs paid for a matching part.",
    inputSchema: { query: z.string().min(1), limit: limitSchema },
    annotations: read,
  }, async ({ query, limit }) => runTool("get_previous_purchase_cost", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query, limit: clampLimit(limit, 10) });
    if (!rows.length) return fail("item_not_found", "No matching purchase history found");
    const purchases = rows.map((row) => ({
      id: row.id,
      part: row.part,
      vendor: row.vendor,
      cost: money(row.unitCost),
      quantity: row.quantity,
      currency: currency(),
      orderedAt: row.orderedAt,
    }));
    return ok({ count: purchases.length, purchases, latestCost: purchases[0].cost, currency: currency() });
  }));

  server.registerTool("compare_supplier_prices", {
    title: "Compare supplier prices",
    description: "Group historical unit costs by vendor for a matching part.",
    inputSchema: { query: z.string().min(1) },
    annotations: read,
  }, async ({ query }) => runTool("compare_supplier_prices", async () => {
    await ensureSchema();
    const rows = await searchPartsOrders({ query, limit: 40 });
    if (!rows.length) return fail("item_not_found", "No matching supplier prices found");
    const byVendor = new Map();
    for (const row of rows) {
      const vendor = row.vendor || "Unknown";
      const cost = money(row.unitCost) || 0;
      const entry = byVendor.get(vendor) || { vendor, count: 0, total: 0, lowest: cost, latestCost: cost, latestOrderedAt: row.orderedAt };
      entry.count += 1;
      entry.total += cost;
      entry.lowest = Math.min(entry.lowest, cost);
      if (!entry.latestOrderedAt || (row.orderedAt && row.orderedAt > entry.latestOrderedAt)) {
        entry.latestCost = cost;
        entry.latestOrderedAt = row.orderedAt;
      }
      byVendor.set(vendor, entry);
    }
    const vendors = [...byVendor.values()].map((entry) => ({
      vendor: entry.vendor,
      purchases: entry.count,
      latestCost: entry.latestCost,
      lowestCost: entry.lowest,
      averageCost: Math.round((entry.total / entry.count) * 100) / 100,
      currency: currency(),
    }));
    return ok({ partQuery: query, vendors });
  }));

  server.registerTool("search_repairs", {
    title: "Search repairs",
    description: "Search repair tickets by device, issue, customer name, status, or ticket id. Does not return full customer contact details.",
    inputSchema: { query: z.string().optional(), status: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ query, status, limit }) => runTool("search_repairs", async () => {
    await ensureSchema();
    if (status && !TICKET_STATUSES.includes(status)) {
      return fail("invalid_input", "Unknown repair status. Use one of: " + TICKET_STATUSES.join(", "));
    }
    const tickets = await searchTickets({ query: query || "", status: status || "", limit: clampLimit(limit) });
    return ok({ count: tickets.length, repairs: tickets.map(summarizeTicket) });
  }));

  server.registerTool("get_repair", {
    title: "Get repair",
    description: "Fetch one repair ticket by id. Phone numbers are masked.",
    inputSchema: { id: z.string().min(1) },
    annotations: read,
  }, async ({ id }) => runTool("get_repair", async () => {
    await ensureSchema();
    const ticket = await getTicketById(id);
    if (!ticket) return fail("item_not_found", "Repair not found: " + id);
    return ok({ repair: summarizeTicket(ticket) });
  }));

  server.registerTool("get_previous_repair_quote", {
    title: "Get previous repair quote",
    description: "Find previous repair tickets with a quoted repair cost for a device or issue.",
    inputSchema: { query: z.string().min(1), limit: limitSchema },
    annotations: read,
  }, async ({ query, limit }) => runTool("get_previous_repair_quote", async () => {
    await ensureSchema();
    const tickets = (await searchTickets({ query, limit: clampLimit(limit, 20) }))
      .filter((ticket) => money(ticket.repairCost) != null);
    if (!tickets.length) return fail("item_not_found", "No previous repair quote found");
    return ok({
      count: tickets.length,
      quotes: tickets.map((ticket) => ({
        id: ticket.id,
        device: ticket.device,
        issues: ticket.issues,
        status: ticket.status,
        repairCost: money(ticket.repairCost),
        currency: currency(),
        created: ticket.created,
      })),
    });
  }));

  server.registerTool("calculate_suggested_retail_price", {
    title: "Calculate suggested retail price",
    description: "Suggest a retail repair price from the shop catalog for a device/repair type, or from a part cost and margin when no catalog price exists.",
    inputSchema: {
      device: z.string().min(1),
      repairType: z.string().optional(),
      partCost: z.number().nonnegative().optional(),
      marginPercent: z.number().min(0).max(95).optional(),
    },
    annotations: read,
  }, async ({ device, repairType, partCost, marginPercent }) => runTool("calculate_suggested_retail_price", async () => {
    await ensureSchema();
    const models = (await listPriceModels()).filter((model) => !model.deleted && matchesQuery(model.name + " " + model.brand, device));
    const catalog = models.map((model) => summarizePriceModel(model, repairType || "")).filter((model) => model.entries.length);
    const catalogPrice = catalog[0]?.entries?.[0]?.price ?? null;
    const margin = marginPercent == null ? 50 : marginPercent;
    let suggested = catalogPrice;
    let source = catalogPrice != null ? "catalog" : null;
    if (suggested == null && partCost != null) {
      suggested = Math.round((partCost / (1 - margin / 100)) * 100) / 100;
      source = "cost_plus_margin";
    }
    if (suggested == null) return fail("item_not_found", "No catalog price found; pass partCost to calculate from margin");
    return ok({
      device,
      repairType: repairType || "",
      suggestedPrice: suggested,
      currency: currency(),
      source,
      marginPercent: source === "cost_plus_margin" ? margin : null,
      catalogMatches: catalog.slice(0, 5),
    });
  }));

  server.registerTool("calculate_margin", {
    title: "Calculate margin",
    description: "Calculate margin and markup between a retail price and a part/cost amount.",
    inputSchema: { retailPrice: z.number().positive(), cost: z.number().nonnegative() },
    annotations: read,
  }, async ({ retailPrice, cost }) => {
    const profit = Math.round((retailPrice - cost) * 100) / 100;
    const marginPercent = Math.round((profit / retailPrice) * 10000) / 100;
    const markupPercent = cost > 0 ? Math.round((profit / cost) * 10000) / 100 : null;
    return ok({ retailPrice, cost, profit, marginPercent, markupPercent, currency: currency() });
  });

  server.registerTool("get_previous_price", {
    title: "Get previous repair price",
    description: "Return the most recent quoted repair cost matching a device or issue.",
    inputSchema: { query: z.string().min(1) },
    annotations: read,
  }, async ({ query }) => runTool("get_previous_price", async () => {
    await ensureSchema();
    const ticket = (await searchTickets({ query, limit: 20 })).find((row) => money(row.repairCost) != null);
    if (!ticket) return fail("item_not_found", "No previous priced repair found");
    return ok({
      id: ticket.id,
      device: ticket.device,
      issues: ticket.issues,
      price: money(ticket.repairCost),
      currency: currency(),
      created: ticket.created,
    });
  }));

  server.registerTool("get_average_price_for_part", {
    title: "Get average repair price",
    description: "Average previous repair quotes matching a device or part/issue query.",
    inputSchema: { query: z.string().min(1) },
    annotations: read,
  }, async ({ query }) => runTool("get_average_price_for_part", async () => {
    await ensureSchema();
    const prices = (await searchTickets({ query, limit: 40 }))
      .map((ticket) => money(ticket.repairCost))
      .filter((value) => value != null);
    if (!prices.length) return fail("item_not_found", "No priced repairs found for that query");
    const average = Math.round((prices.reduce((sum, value) => sum + value, 0) / prices.length) * 100) / 100;
    return ok({
      query,
      count: prices.length,
      averagePrice: average,
      lowestPrice: Math.min(...prices),
      highestPrice: Math.max(...prices),
      currency: currency(),
    });
  }));

  server.registerTool("search_customer", {
    title: "Search customers",
    description: "Search the shop customer directory by name, phone, or id. Returns masked phone numbers only.",
    inputSchema: { query: z.string().min(1), limit: limitSchema },
    annotations: read,
  }, async ({ query, limit }) => runTool("search_customer", async () => {
    await ensureSchema();
    const customers = await searchCustomers({ query, limit: clampLimit(limit) });
    return ok({ count: customers.length, customers: customers.map(summarizeCustomer) });
  }));

  server.registerTool("get_customer", {
    title: "Get customer",
    description: "Fetch one customer by id. Phone is masked; email is not returned.",
    inputSchema: { id: z.string().min(1) },
    annotations: read,
  }, async ({ id }) => runTool("get_customer", async () => {
    await ensureSchema();
    const customer = await getCustomerById(id);
    if (!customer) return fail("item_not_found", "Customer not found: " + id);
    return ok({ customer: summarizeCustomer(customer) });
  }));

  server.registerTool("get_customer_repairs", {
    title: "Get customer repairs",
    description: "List recent repairs for a customer id or name/phone search.",
    inputSchema: { customerId: z.string().optional(), query: z.string().optional(), limit: limitSchema },
    annotations: read,
  }, async ({ customerId, query, limit }) => runTool("get_customer_repairs", async () => {
    await ensureSchema();
    let search = String(query || "").trim();
    if (customerId) {
      const customer = await getCustomerById(customerId);
      if (!customer) return fail("item_not_found", "Customer not found: " + customerId);
      search = customer.name || customer.phone || customerId;
    }
    if (!search) return fail("invalid_input", "customerId or query is required");
    const repairs = (await searchTickets({ query: search, limit: clampLimit(limit) })).map(summarizeTicket);
    return ok({ count: repairs.length, repairs });
  }));

  server.registerTool("add_inventory_item", {
    title: "Add inventory item",
    description: "Create a new inventory sheet row in an existing section (SCREENS, BATTERIES, TOOLS, etc.). Does not delete items.",
    inputSchema: {
      section: z.string().min(1),
      item: z.string().min(1),
      quality: z.string().optional(),
      quantity: z.number().int().min(0),
    },
    annotations: write,
  }, async (args) => {
    const result = await runTool("add_inventory_item", async () => {
      const inventory = await addInventoryItem(args);
      const created = (inventory.items || []).find((candidate) =>
        candidate.section === String(args.section).trim().toUpperCase() &&
        candidate.item.toLowerCase() === String(args.item).trim().toLowerCase() &&
        String(candidate.quality || "").toLowerCase() === String(args.quality || "").trim().toLowerCase()
      );
      return ok({ item: created ? summarizeInventoryItem(created) : null });
    });
    writeLog(actor, "add_inventory_item", result.structuredContent?.item?.key, result);
    return result;
  });

  server.registerTool("update_inventory_item", {
    title: "Update inventory quantity",
    description: "Adjust an existing inventory item quantity by a whole-number delta (positive restock, negative deduct). Cannot delete rows.",
    inputSchema: {
      itemKey: z.string().min(1),
      delta: z.number().int(),
    },
    annotations: write,
  }, async ({ itemKey, delta }) => {
    const result = await runTool("update_inventory_item", async () => {
      if (!Number.isInteger(delta) || delta === 0) return fail("invalid_input", "delta must be a non-zero whole number");
      const movement = await adjustInventoryItem(itemKey, delta, { reason: "MCP inventory update" });
      return ok({ movement });
    });
    writeLog(actor, "update_inventory_item", itemKey, result);
    return result;
  });

  server.registerTool("add_supplier_order", {
    title: "Add supplier order",
    description: "Add a supplier parts-order line. Use for recording a new purchase. Status defaults to ordered.",
    inputSchema: {
      part: z.string().min(1),
      vendor: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      unitCost: z.number().nonnegative().optional(),
      status: z.enum(["ordered", "arrived", "backordered", "cancelled"]).optional(),
      shipmentName: z.string().optional(),
      notes: z.string().optional(),
      ticketId: z.string().optional(),
    },
    annotations: write,
  }, async (args) => {
    const result = await runTool("add_supplier_order", async () => {
      await ensureSchema();
      const order = await addPartsOrder(args);
      return ok({ order: summarizePartsOrder(order) });
    });
    writeLog(actor, "add_supplier_order", result.structuredContent?.order?.id, result);
    return result;
  });

  server.registerTool("mark_part_received", {
    title: "Mark part received",
    description: "Mark a supplier parts-order line as arrived/received. Does not add it to inventory; use add_parts_order_to_inventory for that.",
    inputSchema: { id: z.string().min(1) },
    annotations: write,
  }, async ({ id }) => {
    const result = await runTool("mark_part_received", async () => {
      await ensureSchema();
      const order = await updatePartsOrder({ id, status: "arrived" });
      return ok({ order: summarizePartsOrder(order) });
    });
    writeLog(actor, "mark_part_received", id, result);
    return result;
  });

  server.registerTool("add_parts_order_to_inventory", {
    title: "Add parts order to inventory",
    description: "Add a received/unreceived supplier order into inventory by increasing an existing itemKey or creating a new sheet row.",
    inputSchema: {
      partsOrderId: z.string().min(1),
      itemKey: z.string().optional(),
      section: z.string().optional(),
      item: z.string().optional(),
      quality: z.string().optional(),
    },
    annotations: write,
  }, async (args) => {
    const result = await runTool("add_parts_order_to_inventory", async () => {
      await ensureSchema();
      if (!args.itemKey && !args.item) return fail("invalid_input", "Pass itemKey for an existing item, or section and item to create one");
      const stocked = await stockPartsOrderToInventory(args);
      return ok({
        alreadyStocked: Boolean(stocked.alreadyStocked),
        partsOrder: summarizePartsOrder(stocked.partsOrder),
        movement: stocked.movement || null,
      });
    });
    writeLog(actor, "add_parts_order_to_inventory", args.partsOrderId, result);
    return result;
  });

  server.registerTool("create_repair_quote", {
    title: "Create repair quote",
    description: "Create a new repair ticket with a quoted repair cost. Status defaults to Received. Does not delete anything.",
    inputSchema: {
      device: z.string().min(1),
      issues: z.string().min(1),
      repairCost: z.number().nonnegative().optional(),
      customerName: z.string().optional(),
      phone: z.string().optional(),
      notes: z.string().optional(),
      status: z.string().optional(),
    },
    annotations: write,
  }, async (args) => {
    const result = await runTool("create_repair_quote", async () => {
      await ensureSchema();
      if (args.status && !TICKET_STATUSES.includes(args.status)) {
        return fail("invalid_input", "Unknown repair status. Use one of: " + TICKET_STATUSES.join(", "));
      }
      const ticket = await addTicket({
        device: args.device,
        issues: args.issues,
        repairCost: args.repairCost == null ? undefined : String(args.repairCost),
        customerName: args.customerName || "",
        phone: args.phone || "",
        notes: args.notes || "",
        status: args.status || "Received",
      });
      return ok({ repair: summarizeTicket(ticket) });
    });
    writeLog(actor, "create_repair_quote", result.structuredContent?.repair?.id, result);
    return result;
  });

  server.registerTool("update_repair_status", {
    title: "Update repair status",
    description: "Update a repair ticket status using the shop's existing status list. Does not delete tickets.",
    inputSchema: { id: z.string().min(1), status: z.string().min(1) },
    annotations: write,
  }, async ({ id, status }) => {
    const result = await runTool("update_repair_status", async () => {
      await ensureSchema();
      if (!TICKET_STATUSES.includes(status)) {
        return fail("invalid_input", "Unknown repair status. Use one of: " + TICKET_STATUSES.join(", "));
      }
      const ticket = await updateTicket({ id, status });
      return ok({ repair: summarizeTicket(ticket) });
    });
    writeLog(actor, "update_repair_status", id, result);
    return result;
  });
}
