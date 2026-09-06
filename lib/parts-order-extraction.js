// Reads a supplier order-confirmation PDF with Claude and turns it into
// structured line items. This is the first LLM API call anywhere in this
// codebase — isolated in its own file so the network call and the
// JSON-parsing/validation logic can be tested independently (see
// scripts/test-parts-orders.mjs, which mocks fetch entirely).
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

const EXTRACTION_SYSTEM_PROMPT = `You read supplier parts-order confirmations for a phone/laptop repair shop and extract the order into strict JSON. Return ONLY a JSON object, no prose, no markdown code fences, of exactly this shape:
{"vendor": string, "parts": [{"part": string, "quantity": integer, "unitCost": number}]}

Rules:
- "vendor" is the supplier/company name on the order, or "" if you can't find one.
- Each entry in "parts" is one distinct line item. Do not merge different parts together, and do not include shipping, tax, subtotal, or total lines as parts.
- "quantity" is a whole number, at least 1.
- "unitCost" is the price per unit (not the line total), as a plain number with no currency symbol. If the document only shows a line total, divide by quantity.
- If you can't find any line items at all, return {"vendor": "", "parts": []}.`;

export async function extractPartsFromPdf(pdfBase64) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("AI extraction is not configured (missing ANTHROPIC_API_KEY)");
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: "Extract this order into the JSON shape described." },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`AI extraction failed: HTTP ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const textBlock = (data.content || []).find((block) => block.type === "text");
  if (!textBlock) throw new Error("AI extraction returned no readable content");
  return parseExtractionResult(textBlock.text);
}

// Split out from extractPartsFromPdf so it can be unit-tested directly
// against fixed strings, with no network mocking required.
export function parseExtractionResult(raw) {
  let parsed;
  try {
    // Models sometimes wrap JSON in a ```json fence despite instructions not
    // to — stripped defensively rather than trusting the prompt alone.
    const cleaned = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Couldn't parse the AI's response as JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.parts)) {
    throw new Error('AI response was missing a "parts" array');
  }
  const parts = parsed.parts.map((entry, index) => {
    const part = String(entry?.part || "").trim();
    if (!part) throw new Error(`Line item ${index + 1} is missing a part description`);
    const quantity = Number(entry?.quantity);
    const unitCost = Number(entry?.unitCost);
    return {
      part,
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
      unitCost: isFinite(unitCost) && unitCost >= 0 ? Math.round(unitCost * 100) / 100 : 0,
    };
  });
  return { vendor: String(parsed.vendor || "").trim(), parts };
}
