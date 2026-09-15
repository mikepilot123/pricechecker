// Reads a supplier order-confirmation PDF with Gemini and turns it into
// structured line items. The call stays on the server so GEMINI_API_KEY is
// never exposed to the browser. The Gemini Developer API has a free tier,
// which is a better fit here than Firebase AI Logic's browser SDK because the
// PDF has already been uploaded to R2 and is fetched by this API route.
//
// Gemini is treated as unreliable on purpose: the free tier answers "503 high
// demand" often enough that a single attempt regularly fails an upload, and
// Google retires model names outright (a 404 on gemini-2.5-flash broke this
// route once already). So every request is retried with backoff, and a second
// model stands by in case the first is overloaded or gone.
import { extractPdfText } from "./pdf-text.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Tried in order, cheapest and least contended first. Reading a two-line order
// table is an easy task, so the frontier model is the wrong tool for it: it's
// the most in-demand model on the free tier, which is exactly why it answers
// "503 high demand". Flash-Lite is built for high-throughput work like this,
// gets a higher requests-per-minute allowance, and competes with far fewer
// callers — so it both costs less and fails less. The heavier models stay on
// as fallbacks in case Lite is the one having a bad day.
// GEMINI_MODEL still accepts a single name; a comma-separated list overrides
// the whole chain.
const GEMINI_MODELS = String(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

// Overload and rate-limit answers are transient by definition — retrying is
// the entire point. A bad key or a malformed request fails identically however
// many times it's sent, so those are not retried.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS_PER_MODEL = 3;
const ATTEMPT_TIMEOUT_MS = 20000;
// Has to stay under the route's maxDuration (60s in api/intake.js) with room
// for the response itself, so a slow retry chain never turns into a function
// timeout the browser can't explain.
const TOTAL_BUDGET_MS = 48000;
const BASE_BACKOFF_MS = 700;
const MAX_BACKOFF_MS = 6000;

const EXTRACTION_SYSTEM_PROMPT = `You read supplier parts-order confirmations for a phone/laptop repair shop and extract the order into strict JSON. Return ONLY a JSON object, no prose, no markdown code fences, of exactly this shape:
{"vendor": string, "parts": [{"part": string, "quantity": integer, "unitCost": number}]}

Rules:
- "vendor" is the supplier/company name on the order, or "" if you can't find one.
- Each entry in "parts" is one distinct line item. Do not merge different parts together, and do not include shipping, tax, subtotal, or total lines as parts.
- "quantity" is a whole number, at least 1.
- "unitCost" is the price per unit (not the line total), as a plain number with no currency symbol. If the document only shows a line total, divide by quantity.
- If you can't find any line items at all, return {"vendor": "", "parts": []}.`;

// kind drives the retry loop: "transient" waits and tries again, "model" gives
// up on this model and moves to the next one, "fatal" stops everything.
export const AI_TEMPORARILY_UNAVAILABLE = "AI_TEMPORARILY_UNAVAILABLE";

class ExtractionError extends Error {
  constructor(message, { kind = "transient", detail = "", retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "ExtractionError";
    this.kind = kind;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Full jitter, so two people uploading at the same moment don't retry in step
// and hit the same overloaded minute together.
function backoffMs(attempt, retryAfterMs = 0) {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const jittered = Math.round(exponential / 2 + Math.random() * (exponential / 2));
  return Math.max(jittered, Math.min(retryAfterMs, MAX_BACKOFF_MS));
}

// Gemini sends Retry-After on some rate limits; honour it over our own guess.
function retryAfterMs(res) {
  const header = Number(res.headers?.get?.("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 0;
}

// Text when the PDF has a usable text layer, the PDF itself when it doesn't.
// Text is ~150x smaller and turns this into a plain reading task, which is
// both cheaper and far less likely to be throttled.
function userParts({ pdfBase64, pdfText }) {
  if (pdfText) {
    return [{ text: `Extract this order into the JSON shape described. This is the text of the order confirmation:\n\n${pdfText}` }];
  }
  return [
    { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
    { text: "Extract this order into the JSON shape described." },
  ];
}

function requestBody(source) {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: userParts(source) }],
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
  });
}

async function callGemini({ model, apiKey, source, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody(source),
      signal: controller.signal,
    });
  } catch (err) {
    // A hung connection and a dropped one are both worth another go.
    throw new ExtractionError(
      err?.name === "AbortError"
        ? `Gemini didn't answer within ${Math.round(timeoutMs / 1000)}s`
        : `couldn't reach Gemini (${err?.message || "network error"})`,
      { kind: "transient" },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().then((text) => text.slice(0, 400)).catch(() => "");
    if (res.status === 404) {
      throw new ExtractionError(`model "${model}" is no longer available`, { kind: "model", detail });
    }
    if (RETRYABLE_STATUSES.has(res.status)) {
      throw new ExtractionError(`Gemini is overloaded (HTTP ${res.status})`, {
        kind: "transient",
        detail,
        retryAfterMs: retryAfterMs(res),
      });
    }
    throw new ExtractionError(`Gemini rejected the request (HTTP ${res.status})`, { kind: "fatal", detail });
  }

  const data = await res.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (!text) throw new ExtractionError("Gemini returned no readable content", { kind: "transient" });
  try {
    return parseExtractionResult(text);
  } catch (err) {
    // Model output is non-deterministic, so a mangled answer is worth
    // re-rolling rather than failing the upload outright.
    throw new ExtractionError(err.message, { kind: "transient" });
  }
}

// What the shop actually sees in the review modal. Raw API JSON is useless at
// the counter, so it stays in the server log and this says what to do next.
// Carries the code the review modal keys off to offer manual entry, so a
// busy AI service is a detour rather than a dead end.
function userError(err) {
  if (!err || err.kind === "transient") {
    const error = new Error("The AI service is busy right now. Enter the parts manually below, or try the PDF again later.");
    error.code = AI_TEMPORARILY_UNAVAILABLE;
    return error;
  }
  if (err.kind === "model") {
    const error = new Error(`No AI model was available to read this PDF (tried ${GEMINI_MODELS.join(", ")}). Enter the parts manually below, or set GEMINI_MODEL to a current model.`);
    error.code = AI_TEMPORARILY_UNAVAILABLE;
    return error;
  }
  return new Error("The AI service could not read this PDF. Try another PDF or enter the parts manually.");
}

export async function extractPartsFromPdf(pdfBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("AI extraction is not configured (missing GEMINI_API_KEY)");
  if (!GEMINI_MODELS.length) throw new Error("AI extraction is not configured (GEMINI_MODEL is empty)");

  // Falls back to "" for a scan or anything else with no text layer, in which
  // case the PDF goes to the model as an image exactly as before.
  const pdfText = await extractPdfText(Buffer.from(pdfBase64, "base64"));
  console.log(`[parts-pdf] input: ${pdfText ? pdfText.length + " chars of text" : "PDF image (no text layer)"}`);
  const source = { pdfBase64, pdfText };

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 1000) throw userError(lastError);
      try {
        return await callGemini({
          model,
          apiKey,
          source,
          timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remaining),
        });
      } catch (err) {
        lastError = err;
        if (err.kind === "fatal") {
          console.error(`[parts-pdf] ${model}: ${err.message} — ${err.detail}`);
          throw userError(err);
        }
        console.warn(`[parts-pdf] ${model} attempt ${attempt}/${ATTEMPTS_PER_MODEL}: ${err.message}${err.detail ? " — " + err.detail : ""}`);
        if (err.kind === "model") break; // retired/unknown model: next one, now
        if (attempt === ATTEMPTS_PER_MODEL) break;
        const wait = backoffMs(attempt, err.retryAfterMs);
        if (deadline - Date.now() <= wait + 1000) break;
        await sleep(wait);
      }
    }
  }
  throw userError(lastError);
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
