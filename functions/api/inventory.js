import { addInventoryItem, adjustInventoryItem, listInventory } from "../_lib/inventory.js";
import { checkPin, jsonResponse, preflightResponse } from "../_lib/security.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return preflightResponse(request);
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, request, 405);
  }

  try {
    if (request.method === "POST") {
      const body = await readBody(request);
      const denied = checkPin(request, body.pin, env);
      if (denied) {
        return jsonResponse({ ok: false, error: denied.error }, request, denied.status);
      }
      if (body.action === "addItem") {
        const inventory = await addInventoryItem({
          section: body.section, item: body.item, quality: body.quality, quantity: body.quantity,
        });
        return jsonResponse({ ok: true, ...inventory }, request);
      }
      if (body.action !== "adjust") {
        return jsonResponse({ ok: false, error: "Unknown action: " + (body.action || "") }, request);
      }
      const delta = Number(body.delta);
      if (!Number.isInteger(delta) || delta === 0) {
        return jsonResponse({ ok: false, error: "Inventory adjustment must be a non-zero whole number" }, request);
      }
      const movement = await adjustInventoryItem(String(body.itemKey || ""), delta, {
        reason: "Manual inventory update",
      });
      const inventory = await listInventory();
      return jsonResponse({ ok: true, movement, ...inventory }, request);
    }

    const inventory = await listInventory();
    return jsonResponse({ ok: true, ...inventory }, request);
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) }, request);
  }
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
