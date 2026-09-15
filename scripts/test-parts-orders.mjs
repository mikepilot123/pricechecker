// Real Postgres integration checks for parts orders (tracking + customer/
// ticket linking), plus a network-free unit test of the PDF-extraction
// response parser.
import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { deflateRawSync } from "node:zlib";
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
const {
  addPartsOrder, updatePartsOrder, listPartsOrders, deletePartsOrder, renamePartsShipment,
  setPartsShipmentPaymentStatus,
  claimPartsOrderForInventory, completePartsOrderInventory, releasePartsOrderInventoryClaim,
} = await import("../lib/parts-orders.js");
const { listCustomers } = await import("../lib/customers.js");
const { extractPartsFromPdf, parseExtractionResult } = await import("../lib/parts-order-extraction.js");
const { default: handler } = await import("../api/intake.js");
const xlsxSandbox = { window: {}, TextDecoder, Uint8Array, DataView, Blob, Response, DecompressionStream };
runInNewContext(readFileSync(new URL("../assets/parts-order-xlsx.js", import.meta.url), "utf8"), xlsxSandbox);
const parsePartsOrderXlsx = xlsxSandbox.window.RPC_PARSE_PARTS_ORDER_XLSX;
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

await test("a shipment name applies to every part in its batch", async () => {
  await addPartsOrder({ id: "shipment-a", batchId: "batch-rename", part: "Screen", quantity: 1, unitCost: 20 });
  await addPartsOrder({ id: "shipment-b", batchId: "batch-rename", part: "Adhesive", quantity: 1, unitCost: 2 });
  const renamed = await renamePartsShipment({ batchId: "batch-rename", shipmentName: "Pixel 7 Pro order" });
  assert.equal(renamed.updatedCount, 2);
  const shipment = (await listPartsOrders()).filter((p) => p.batchId === "batch-rename");
  assert.equal(shipment.length, 2);
  assert.ok(shipment.every((p) => p.shipmentName === "Pixel 7 Pro order"));
});

await test("a new part defaults to pending payment, and a shipment's payment status applies to every part in its batch", async () => {
  const p = await addPartsOrder({ id: "part-payment-default", part: "Screen", quantity: 1, unitCost: 20 });
  assert.equal(p.paymentStatus, "pending");

  await addPartsOrder({ id: "shipment-pay-a", batchId: "batch-payment", part: "Screen", quantity: 1, unitCost: 20 });
  await addPartsOrder({ id: "shipment-pay-b", batchId: "batch-payment", part: "Adhesive", quantity: 1, unitCost: 2 });
  const collected = await setPartsShipmentPaymentStatus({ batchId: "batch-payment", paymentStatus: "collected" });
  assert.equal(collected.updatedCount, 2);
  let shipment = (await listPartsOrders()).filter((x) => x.batchId === "batch-payment");
  assert.ok(shipment.every((x) => x.paymentStatus === "collected"));

  await setPartsShipmentPaymentStatus({ batchId: "batch-payment", paymentStatus: "pending" });
  shipment = (await listPartsOrders()).filter((x) => x.batchId === "batch-payment");
  assert.ok(shipment.every((x) => x.paymentStatus === "pending"));

  await assert.rejects(setPartsShipmentPaymentStatus({ batchId: "batch-payment", paymentStatus: "bogus" }), /pending.*collected/i);
  await assert.rejects(setPartsShipmentPaymentStatus({ batchId: "no-such-batch", paymentStatus: "collected" }), /Shipment not found/);
});

await test("inventory stocking claims are idempotent and mark the part arrived", async () => {
  await addPartsOrder({ id: "part-stock", part: "Pixel 8 screen", quantity: 3, unitCost: 40 });
  const claim = await claimPartsOrderForInventory({ partsOrderId: "part-stock" });
  assert.equal(claim.alreadyStocked, false);
  assert.equal(claim.partsOrder.quantity, 3);
  await assert.rejects(claimPartsOrderForInventory({ partsOrderId: "part-stock" }), /already being added/);
  await releasePartsOrderInventoryClaim({ partsOrderId: "part-stock" });
  await claimPartsOrderForInventory({ partsOrderId: "part-stock" });
  const stocked = await completePartsOrderInventory({
    partsOrderId: "part-stock", itemKey: "SCREENS|Pixel%208|OLED", itemLabel: "Pixel 8 · OLED", quantity: 3,
  });
  assert.equal(stocked.status, "arrived");
  assert.equal(stocked.inventoryStockedQuantity, 3);
  assert.equal(stocked.inventoryItemLabel, "Pixel 8 · OLED");
  assert.ok(stocked.inventoryStockedAt);
  const retry = await claimPartsOrderForInventory({ partsOrderId: "part-stock" });
  assert.equal(retry.alreadyStocked, true);
  await assert.rejects(updatePartsOrder({ id: "part-stock", quantity: 4 }), /can't be changed/);
  await assert.rejects(updatePartsOrder({ id: "part-stock", ticketId: "TICKET-789" }), /already in inventory/);
  await assert.rejects(updatePartsOrder({ id: "part-stock", status: "ordered" }), /must stay marked arrived/);
});

await test("cancelled orders cannot be added to inventory", async () => {
  await addPartsOrder({ id: "part-cancelled-stock", part: "Cancelled screen", quantity: 1, status: "cancelled" });
  await assert.rejects(claimPartsOrderForInventory({ partsOrderId: "part-cancelled-stock" }), /cancelled part order/);
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

await test("temporary AI outages are retried before PDF extraction succeeds", async () => {
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: 503, message: "high demand" } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ vendor: "Supplier", parts: [{ part: "Screen", quantity: 1, unitCost: 25 }] }) }] } }] }), { status: 200 });
  };
  try {
    const result = await extractPartsFromPdf("cGRmLWJ5dGVz");
    assert.equal(calls, 2);
    assert.equal(result.parts[0].part, "Screen");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

await test("persistent AI 503 returns a short fallback message, not raw service JSON", async () => {
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand" } }), { status: 503 });
  };
  try {
    await assert.rejects(extractPartsFromPdf("cGRmLWJ5dGVz"), (error) => {
      assert.equal(error.code, "AI_TEMPORARILY_UNAVAILABLE");
      assert.match(error.message, /enter the parts manually/i);
      assert.doesNotMatch(error.message, /HTTP 503|high demand|UNAVAILABLE/);
      return true;
    });
    // 3 attempts against each of the 3 models in the fallback chain.
    assert.equal(calls, 9);
    const viaApi = await api({ pin: "0000", action: "extractPartsOrderPdf", pdfBase64: "cGRmLWJ5dGVz" });
    assert.equal(viaApi.payload.ok, false);
    assert.equal(viaApi.payload.code, "AI_TEMPORARILY_UNAVAILABLE");
    assert.match(viaApi.payload.error, /enter the parts manually/i);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
});

// ---- PDF extraction reliability: Gemini is flaky, so the route retries ----
function geminiOk() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      vendor: "MobileSentrix",
      parts: [{ part: "Pixel screen", quantity: 1, unitCost: 50 }],
    }) }] } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function withStubbedGemini(handler, run) {
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(calls.length, String(url), options);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
}

await test("a 503 'high demand' is retried instead of failing the upload", async () => {
  await withStubbedGemini(
    (call) => call === 1
      ? new Response('{"error":{"code":503,"message":"high demand"}}', { status: 503 })
      : geminiOk(),
    async (calls) => {
      const extracted = await extractPartsFromPdf("cGRmLWJ5dGVz");
      assert.equal(calls.length, 2, "should have retried once after the 503");
      assert.equal(extracted.vendor, "MobileSentrix");
    },
  );
});

await test("a retired model (404) falls through to the backup model", async () => {
  await withStubbedGemini(
    (_call, url) => url.includes("gemini-3.5-flash-lite")
      ? new Response('{"error":{"code":404,"message":"not found"}}', { status: 404 })
      : geminiOk(),
    async (calls) => {
      const extracted = await extractPartsFromPdf("cGRmLWJ5dGVz");
      // Straight to the fallback: a retired model never comes back, so it
      // must not burn the retry budget first.
      assert.equal(calls.length, 2);
      assert.match(calls[1], /gemini-3\.6-flash/);
      assert.equal(extracted.vendor, "MobileSentrix");
    },
  );
});

await test("a bad request fails fast rather than retrying a doomed call", async () => {
  await withStubbedGemini(
    () => new Response('{"error":{"code":400,"message":"API key not valid"}}', { status: 400 }),
    async (calls) => {
      await assert.rejects(extractPartsFromPdf("cGRmLWJ5dGVz"), /could not read this PDF/);
      assert.equal(calls.length, 1, "400 is not transient — one call only");
    },
  );
});

await test("an exhausted retry chain reports a plain-English busy message", async () => {
  await withStubbedGemini(
    () => new Response('{"error":{"code":503,"message":"high demand"}}', { status: 503 }),
    async (calls) => {
      await assert.rejects(extractPartsFromPdf("cGRmLWJ5dGVz"), (err) => {
        assert.match(err.message, /busy right now/);
        assert.doesNotMatch(err.message, /\{/, "raw API JSON should stay in the server log");
        return true;
      });
      // 3 attempts on each model in the chain.
      assert.equal(calls.length, 9);
    },
  );
});

// Builds a real (tiny) PDF with a genuine text layer, so the text-vs-image
// decision is exercised against actual pdfjs rather than a mock of it.
function makeTextPdf(lines) {
  const content = "BT /F1 12 Tf " + lines.map((line, i) =>
    `1 0 0 1 50 ${700 - i * 20} Tm (${line.replace(/([()\\])/g, "\\$1")}) Tj`).join(" ") + " ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj${body}endobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")
    + `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

await test("a PDF with a text layer is sent as text, not as a 150KB image", async () => {
  const pdfBase64 = makeTextPdf([
    "MobileSentrix Order Confirmation",
    "Product Description SKU Unit Price Quantity Subtotal",
    "Replacement Battery For Google Pixel 6 GMSB3 109082004843 $8.10 1 $8.10",
    "Inner OLED Assembly With Frame For Samsung Galaxy Z Flip 3 $129.66 1 $129.66",
    "Subtotal: $137.76 Grand Total: $151.67 Order Number 108620485",
  ]);
  await withStubbedGemini(() => geminiOk(), async () => {
    await extractPartsFromPdf(pdfBase64);
  });
  // Re-run capturing the body so we can assert on what was actually sent.
  let body;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return geminiOk(); };
  try {
    await extractPartsFromPdf(pdfBase64);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
  const parts = body.contents[0].parts;
  assert.ok(!parts.some((p) => p.inlineData), "must not ship the PDF as an image when text is available");
  assert.match(parts[0].text, /Replacement Battery For Google Pixel 6/);
  assert.match(parts[0].text, /\$129\.66/);
});

await test("a PDF with no readable text layer still falls back to the image path", async () => {
  // Not a parseable PDF at all — the worst case the text extractor can hit.
  const notAPdf = Buffer.from("this is not a pdf at all").toString("base64");
  let body;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return geminiOk(); };
  try {
    await extractPartsFromPdf(notAPdf);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  }
  const parts = body.contents[0].parts;
  assert.ok(parts.some((p) => p.inlineData?.mimeType === "application/pdf"), "should send the PDF itself when there's no text");
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

// ---- Browser-only Excel import (no model/API call) ----
function testXlsx(files, compressed = true) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = compressed ? deflateRawSync(raw) : raw;
    const method = compressed ? 8 : 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, centralBytes, end]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function workbook(sheetXml, extras = {}, compressed = true) {
  return testXlsx({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml,
    ...extras,
  }, compressed);
}

await test("Excel import accepts shared strings, aliases, quoted commas, and numeric costs", async () => {
  const shared = '<sst><si><t>description</t></si><si><t>qty</t></si><si><t>price</t></si><si><t>supplier</t></si><si><t>shipment name</t></si><si><t>Pixel 7 screen, OLED</t></si><si><t>MobileSentrix</t></si><si><t>September order</t></si><si><t>Battery</t></si></sst>';
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>2</v></c><c r="C2"><v>45.50</v></c><c r="D2" t="s"><v>6</v></c><c r="E2" t="s"><v>7</v></c></row>'
    + '<row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3"><v>3</v></c><c r="C3"><v>12.999</v></c></row>'
    + '</sheetData></worksheet>';
  const result = await parsePartsOrderXlsx(workbook(sheet, { "xl/sharedStrings.xml": shared }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    vendor: "MobileSentrix",
    shipmentName: "September order",
    parts: [
      { part: "Pixel 7 screen, OLED", quantity: 2, unitCost: 45.5 },
      { part: "Battery", quantity: 3, unitCost: 13 },
    ],
  });
});

await test("Excel import reads inline strings and defaults optional quantity and cost", async () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>part</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>Pixel 6 &amp; 6a battery</t></is></c></row></sheetData></worksheet>';
  const result = await parsePartsOrderXlsx(workbook(sheet, {}, false));
  assert.deepEqual(JSON.parse(JSON.stringify(result.parts)), [{ part: "Pixel 6 & 6a battery", quantity: 1, unitCost: 0 }]);
});

await test("Excel import finds a parts sheet after a cover sheet", async () => {
  const cover = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Supplier order</t></is></c></row></sheetData></worksheet>';
  const orders = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>item</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Screen</t></is></c></row></sheetData></worksheet>';
  const files = {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Cover" sheetId="1" r:id="rId1"/><sheet name="Orders" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": cover,
    "xl/worksheets/sheet2.xml": orders,
  };
  const result = await parsePartsOrderXlsx(testXlsx(files));
  assert.equal(result.parts[0].part, "Screen");
});

await test("Excel import accepts a title row above the header", async () => {
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>September supplier order</t></is></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>Part</t></is></c><c r="B3" t="inlineStr"><is><t>Quantity</t></is></c></row>'
    + '<row r="4"><c r="A4" t="inlineStr"><is><t>Pixel display</t></is></c><c r="B4"><v>2</v></c></row>'
    + '</sheetData></worksheet>';
  const result = await parsePartsOrderXlsx(workbook(sheet));
  assert.deepEqual(JSON.parse(JSON.stringify(result.parts)), [{ part: "Pixel display", quantity: 2, unitCost: 0 }]);
});

await test("Excel import reports invalid workbooks and incomplete rows", async () => {
  await assert.rejects(parsePartsOrderXlsx(new Uint8Array([1, 2, 3]).buffer), /valid.*xlsx/i);
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>part</t></is></c></row><row r="2"><c r="B2"><v>1</v></c></row></sheetData></worksheet>';
  await assert.rejects(parsePartsOrderXlsx(workbook(sheet)), /Row 2.*missing/i);
});

await test("Excel import reports missing part columns", async () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>quantity</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>';
  await assert.rejects(parsePartsOrderXlsx(workbook(sheet)), (error) => {
    assert.equal(error.code, "NO_PART_COLUMN");
    assert.match(error.message, /part.*column/i);
    return true;
  });
});

console.log(`PASS — ${passed} parts order scenarios`);
await db.close();
