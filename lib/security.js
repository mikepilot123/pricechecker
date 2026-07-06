// Shared request hardening for the api/* handlers.
//
// CORS: the static frontend lives on GitHub Pages, so requests are always
// cross-origin. Previously every handler sent Allow-Origin: * — now only
// known frontends (plus localhost for development) get a CORS pass. Note
// this protects browsers, not curl; the PIN check is still the real gate.
//
// Rate limiting: the PIN is the whole auth model, so unlimited guessing was
// the biggest hole. This is a per-instance in-memory counter — serverless
// instances don't share state, so a determined attacker spread across many
// cold starts gets more attempts than the nominal limit, but casual
// brute-forcing against a warm instance goes from thousands of guesses a
// minute to a handful.

const ALLOWED_ORIGINS = new Set([
  "https://mikepilot123.github.io",
  "http://127.0.0.1:8131",
  "http://localhost:8131",
]);

export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 10;
const failures = new Map(); // ip -> { count, windowStart }

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  return fwd.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

/**
 * PIN gate with lockout. Returns null when the request may proceed, or a
 * { status, error } object the handler should respond with and stop.
 */
export function checkPin(req, pin) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && now - entry.windowStart < WINDOW_MS && entry.count >= MAX_FAILURES_PER_WINDOW) {
    return { status: 429, error: "Too many failed attempts. Try again later." };
  }
  if (String(pin) === String(process.env.INTAKE_PIN) && process.env.INTAKE_PIN) {
    if (entry) failures.delete(ip);
    return null;
  }
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    failures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  // Opportunistic cleanup so the map can't grow unbounded on a long-lived instance.
  if (failures.size > 1000) {
    for (const [key, value] of failures) {
      if (now - value.windowStart >= WINDOW_MS) failures.delete(key);
    }
  }
  return { status: 200, error: "Invalid PIN" };
}
