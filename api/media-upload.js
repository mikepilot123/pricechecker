import crypto from "node:crypto";
import { applyCors, checkPin } from "../lib/security.js";
import { getUploadUrl, r2PublicUrl } from "../lib/r2.js";

// Issues a short-lived presigned R2 PUT URL for the browser to upload a
// ticket photo/video directly to — same reason the old Vercel Blob version
// worked this way: it keeps big video uploads off this app's Vercel
// functions, which cap request bodies around ~4.5MB.
//
// Flow: frontend POSTs {pin, ticketId, filename, contentType, size} here,
// gets back {uploadUrl, key, url}, PUTs the file bytes straight to
// `uploadUrl`, then calls action=addMedia (api/intake.js) with the
// resulting `url`/`key` to record it in ticket_media. Two requests, same
// shape as the previous two-phase Blob handshake.
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MAX_BYTES = 50 * 1024 * 1024;

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

  const ticketId = String(body.ticketId || "").trim();
  if (!ticketId) return res.status(400).json({ error: "Ticket ID is required" });

  const contentType = String(body.contentType || "");
  if (!ALLOWED_TYPES.has(contentType)) {
    return res.status(400).json({ error: "Unsupported file type: " + (contentType || "(none)") });
  }

  const size = Number(body.size || 0);
  if (!size || !Number.isFinite(size) || size > MAX_BYTES) {
    return res.status(400).json({ error: "That file is over 50MB — trim the video or pick a smaller one." });
  }

  try {
    const extMatch = String(body.filename || "").match(/\.[a-zA-Z0-9]+$/);
    const ext = extMatch ? extMatch[0].toLowerCase() : "";
    const key = `tickets/${ticketId}/${Date.now()}-${crypto.randomUUID()}${ext}`;

    const uploadUrl = await getUploadUrl(key, contentType);
    return res.status(200).json({ ok: true, uploadUrl, key, url: r2PublicUrl(key) });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
