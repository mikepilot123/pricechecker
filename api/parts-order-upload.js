import crypto from "node:crypto";
import { applyCors, checkPin } from "../lib/security.js";
import { getUploadUrl, r2PublicUrl } from "../lib/r2.js";

// Issues a short-lived presigned R2 PUT URL for the browser to upload a
// supplier order-confirmation PDF directly to — same reason
// api/media-upload.js does this for ticket photos/videos: it keeps the file
// bytes off this app's Vercel functions, which cap request bodies around
// ~4.5MB.
//
// Flow: frontend POSTs {pin, batchId, filename, contentType, size} here, gets
// back {uploadUrl, key, url}, PUTs the PDF bytes straight to `uploadUrl`,
// then calls action=extractPartsOrderPdf (api/intake.js) with the resulting
// `url` to have it read.
const ALLOWED_TYPES = new Set(["application/pdf"]);
const MAX_BYTES = 10 * 1024 * 1024;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const denied = checkPin(req, body.pin);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  const batchId = String(body.batchId || "").trim();
  if (!batchId) return res.status(400).json({ error: "Batch ID is required" });

  const contentType = String(body.contentType || "");
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(400).json({ error: "Only PDF files are accepted" });
  }

  const size = Number(body.size || 0);
  if (!size || !Number.isFinite(size) || size > MAX_BYTES) {
    return res.status(400).json({ error: "That file is over 10MB — split the order or trim the PDF." });
  }

  try {
    const key = `parts-orders/${batchId}/${Date.now()}-${crypto.randomUUID()}.pdf`;
    const uploadUrl = await getUploadUrl(key, contentType);
    return res.status(200).json({ ok: true, uploadUrl, key, url: r2PublicUrl(key) });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
