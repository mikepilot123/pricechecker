// Real Postgres integration checks for parts orders (tracking + customer/
// ticket linking), plus a network-free unit test of the PDF-extraction
// response parser.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const standin = new URL("./testing/neon-pglite.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "@neondatabase/serverless" ? standin : specifier, context);
} });
process.env.DATABASE_URL = "pglite://memory";
process.env.INTAKE_PIN = "0000";
const { db } = await import("./testing/neon-pglite.mjs");
const { sql, ensureSchema } = await import("../lib/db.js");
const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
await db.exec(readFileSync(new URL(files[0], migrations), "utf8"));
await ensureSchema();
for (const file of files.slice(1)) await db.exec(readFileSync(new URL(file, migrations), "utf8"));
const { addPartsOrder, updatePartsOrder, listPartsOrders, deletePartsOrder } = await import("../lib/parts-orders.js");
const { listCustomers } = await import("../lib/customers.js");
const { extractPartsFromPdf, parseExtractionResult } = await import("../lib/parts-order-extraction.js");
const { default: handler } = await import("../api/intake.js");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("  ok  " + name); }

await test("adding a part computes total cost and defaults to ordered", async () => {
  const p = await addPartsOrder({ id: "part-test", part: "iPhone 13 screen (soft)", vendor: "iFixit", quantity: 2, unitCost: 45.5 });
  assert.equal(p.status, "ordered");
  assert.equal(p.totalCost, 91);
  assert.equal(p.arrivedAt, null);
  assert.equal(p.source, "manual");
});

await test("a customer phone resolves/creates a directory entry", async () => {
  await addPartsOrder({ id: "part-cust", part: "Battery", quantity: 1, unitCost: 20, customerName: "Anita Singh", customerPhone: "868 712 3456" });
  const p = (await listPartsOrders()).find((x) => x.id === "part-cust");
  assert.ok(p.customerId, "customerId should be set");
  const directory = await listCustomers();
  assert.ok(directory.some((c) => c.id === p.customerId && c.name === "Anita Singh"));
});

await test("no phone means no directory entry, but the part still saves", async () => {
  const p = await addPartsOrder({ id: "part-nophone", part: "Charging port", quantity: 1, unitCost: 10, customerName: "Walk-in" });
  assert.equal(p.customerId, null);
  assert.equal(p.customerName, "Walk-in");
});

await test("a ticket link round-trips", async () => {
  const p = await addPartsOrder({ id: "part-ticket", part: "Back glass", quantity: 1, unitCost: 15, ticketId: "TICKET-123" });
  assert.equal(p.ticketId, "TICKET-123");
  const updated = await updatePartsOrder({ id: "part-ticket", ticketId: "TICKET-456" });
  assert.equal(updated.ticketId, "TICKET-456");
});

await test("marking arrived stamps arrivedAt; reopening clears it", async () => {
  const arrived = await updatePartsOrder({ id: "part-test", status: "arrived" });
  assert.ok(arrived.arrivedAt);
  const reopened = await updatePartsOrder({ id: "part-test", status: "backordered" });
  assert.equal(reopened.arrivedAt, null);
});

await test("invalid quantity/cost are rejected", async () => {
  await assert.rejects(addPartsOrder({ id: "bad-1", part: "X", quantity: 0 }), /Quantity/);
  await assert.rejects(addPartsOrder({ id: "bad-2", part: "X", quantity: 1, unitCost: -5 }), /Unit cost/);
  await assert.rejects(addPartsOrder({ id: "bad-3", part: "" }), /Part description/);
});

await test("deleting a part removes it from the list", async () => {
  await deletePartsOrder({ id: "part-nophone" });
  assert.equal((await listPartsOrders()).some((p) => p.id === "part-nophone"), false);
  await assert.rejects(deletePartsOrder({ id: "part-nophone" }), /not found/);
});

async function api(body) {
  let status, payload;
  const response = { setHeader() {}, status(code) { status = code; return this; }, json(value) { payload = value; return this; } };
  await handler({ method: "POST", headers: {}, body: JSON.stringify(body) }, response);
  return { status, payload };
}
await test("API actions require the PIN and round-trip through addPartsOrder/listPartsOrders", async () => {
  const denied = await api({ action: "addPartsOrder", part: "Speaker", quantity: 1, unitCost: 5 });
  assert.equal(denied.status, 200);
  assert.equal(denied.payload.ok, false);
  const saved = await api({ pin: "0000", action: "addPartsOrder", id: "part-api", part: "Speaker", quantity: 1, unitCost: 5 });
  assert.equal(saved.payload.ok, true);
  const listed = await api({ pin: "0000", action: "listPartsOrders" });
  assert.ok(listed.payload.partsOrders.some((p) => p.id === "part-api"));
});
await test("extractPartsOrderPdf requires PDF data", async () => {
  const res = await api({ pin: "0000", action: "extractPartsOrderPdf" });
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /PDF data is required/);
});

await test("PDF extraction sends the PDF to Gemini and reads its structured JSON", async () => {
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        vendor: "MobileSentrix",
        parts: [{ part: "Pixel screen", quantity: 2, unitCost: 50 }],
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const extracted = await extractPartsFromPdf("cGRmLWJ5dGVz");
    assert.match(request.url, /generativelanguage\.googleapis\.com/);
    assert.match(request.url, /key=test-key/);
    const body = JSON.parse(request.options.body);
    assert.equal(body.contents[0].parts[0].inlineData.mimeType, "application/pdf");
    assert.equal(body.contents[0].parts[0].inlineData.data, "cGRmLWJ5dGVz");
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(extracted, { vendor: "MobileSentrix", parts: [{ part: "Pixel screen", quantity: 2, unitCost: 50 }] });

    const viaApi = await api({ pin: "0000", action: "extractPartsOrderPdf", pdfBase64: "cGRmLWJ5dGVz" });
    assert.equal(viaApi.payload.ok, true);
    assert.equal(viaApi.payload.vendor, "MobileSentrix");
    assert.equal(viaApi.payload.parts[0].part, "Pixel screen");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

// ---- PDF-extraction response parsing (no network, no real PDF) ----
await test("a well-formed extraction response parses into clean line items", () => {
  const result = parseExtractionResult(JSON.stringify({
    vendor: "  iFixit Supply Co. ",
    parts: [
      { part: "iPhone 13 screen", quantity: 2, unitCost: 45.5 },
      { part: "Battery", quantity: "3", unitCost: "12.999" },
    ],
  }));
  assert.equal(result.vendor, "iFixit Supply Co.");
  assert.deepEqual(result.parts, [
    { part: "iPhone 13 screen", quantity: 2, unitCost: 45.5 },
    { part: "Battery", quantity: 3, unitCost: 13 },
  ]);
});
await test("a fenced code block around the JSON is stripped", () => {
  const result = parseExtractionResult("```json\n" + JSON.stringify({ vendor: "X", parts: [] }) + "\n```");
  assert.deepEqual(result, { vendor: "X", parts: [] });
});
await test("malformed or missing-shape responses are rejected, not silently accepted", () => {
  assert.throws(() => parseExtractionResult("not json"), /parse/i);
  assert.throws(() => parseExtractionResult(JSON.stringify({ vendor: "X" })), /parts/);
  assert.throws(() => parseExtractionResult(JSON.stringify({ parts: [{ quantity: 1, unitCost: 5 }] })), /missing a part description/);
});
await test("a missing/invalid quantity or cost in a line item falls back sanely rather than throwing", () => {
  const result = parseExtractionResult(JSON.stringify({ parts: [{ part: "Screw kit", quantity: -1, unitCost: "N/A" }] }));
  assert.deepEqual(result.parts, [{ part: "Screw kit", quantity: 1, unitCost: 0 }]);
});

console.log(`PASS — ${passed} parts order scenarios`);
await db.close();
