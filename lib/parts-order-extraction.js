// Reads a supplier order-confirmation PDF with Gemini and turns it into
// structured line items. The call stays on the server so GEMINI_API_KEY is
// never exposed to the browser. The Gemini Developer API has a free tier,
// which is a better fit here than Firebase AI Logic's browser SDK because the
// PDF has already been uploaded to R2 and is fetched by this API route.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const EXTRACTION_SYSTEM_PROMPT = `You read supplier parts-order confirmations for a phone/laptop repair shop and extract the order into strict JSON. Return ONLY a JSON object, no prose, no markdown code fences, of exactly this shape:
{"vendor": string, "parts": [{"part": string, "quantity": integer, "unitCost": number}]}

Rules:
- "vendor" is the supplier/company name on the order, or "" if you can't find one.
- Each entry in "parts" is one distinct line item. Do not merge different parts together, and do not include shipping, tax, subtotal, or total lines as parts.
- "quantity" is a whole number, at least 1.
- "unitCost" is the price per unit (not the line total), as a plain number with no currency symbol. If the document only shows a line total, divide by quantity.
- If you can't find any line items at all, return {"vendor": "", "parts": []}.`;

export async function extractPartsFromPdf(pdfBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("AI extraction is not configured (missing GEMINI_API_KEY)");
  const res = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          { text: "Extract this order into the JSON shape described." },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            vendor: { type: "string" },
            parts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  part: { type: "string" },
                  quantity: { type: "integer" },
                  unitCost: { type: "number" },
                },
                required: ["part", "quantity", "unitCost"],
              },
            },
          },
          required: ["vendor", "parts"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`AI extraction failed: HTTP ${res.status} — ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!text) throw new Error("AI extraction returned no readable content");
  return parseExtractionResult(text);
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
