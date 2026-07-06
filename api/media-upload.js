import { handleUpload } from "@vercel/blob/client";
import { applyCors } from "../lib/security.js";

// Separate from api/intake.js because @vercel/blob/client's upload() helper
// POSTs its own fixed request shape ({type: "blob.generate-client-token", ...})
// to this URL — it doesn't go through this repo's {action, pin} convention,
// so it can't share intake.js's action dispatch. The PIN check instead reads
// `pin` out of clientPayload (set by the frontend before calling upload()).
//
// This two-phase handshake is why the upload can't just be proxied through a
// normal JSON API endpoint: phase 1 (this handler) issues a short-lived
// upload token, phase 2 is the browser PUTting the file bytes directly to
// Vercel Blob, bypassing Vercel serverless functions' ~4.5MB body limit
// entirely — necessary since videos can easily exceed that.
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const body = req.body;
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {};
        try { payload = JSON.parse(clientPayload || "{}"); } catch {}
        if (String(payload.pin) !== String(process.env.INTAKE_PIN)) {
          throw new Error("Invalid PIN");
        }
        if (!payload.ticketId) {
          throw new Error("Ticket ID is required");
        }
        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/heic",
            "video/mp4",
            "video/quicktime",
            "video/webm",
          ],
          maximumSizeInBytes: 50 * 1024 * 1024,
          tokenPayload: JSON.stringify({ ticketId: payload.ticketId }),
        };
      },
      onUploadCompleted: async () => {
        // No-op: the frontend calls action=addMedia (api/intake.js) itself
        // right after upload() resolves, so there's no need to also record
        // it here — and this webhook callback isn't reachable from localhost
        // during local development anyway.
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    return res.status(400).json({ error: String((err && err.message) || err) });
  }
}
