// Shared request hardening for the functions/api/* handlers (Cloudflare
// Pages Functions — Fetch API style, ported from lib/security.js which
// used Vercel's Node (req, res) handler shape).
//
// CORS: the static frontend lives on GitHub Pages, so requests are always
// cross-origin. Only known frontends (plus localhost for development) get
// a CORS pass. Note this protects browsers, not curl; the PIN check is
// still the real gate.
//
// Rate limiting: the PIN is the whole auth model, so unlimited guessing was
// the biggest hole. This is a per-isolate in-memory counter — Cloudflare
// can spin up multiple isolates, so a determined attacker spread across
// many cold starts gets more attempts than the nominal limit, but casual
// brute-forcing against a warm isolate goes from thousands of guesses a
// minute to a handful. Same tradeoff as the original Vercel version.

const ALLOWED_ORIGINS = new Set([
  "https://mikepilot123.github.io",
  "http://127.0.0.1:8131",
  "http://localhost:8131",
]);

export function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const headers = new Headers();
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return headers;
}

export function jsonResponse(data, request, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

export function preflightResponse(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 10;
const failures = new Map(); // ip -> { count, windowStart }

function clientIp(request) {
  // Cloudflare sets this to the real client IP on every request — more
  // reliable than trusting a client-suppliable X-Forwarded-For header.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

/**
 * PIN gate with lockout. Returns null when the request may proceed, or a
 * { status, error } object the handler should respond with and stop.
 * `env` is the Pages Function environment (holds INTAKE_PIN).
 */
export function checkPin(request, pin, env) {
  const ip = clientIp(request);
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && now - entry.windowStart < WINDOW_MS && entry.count >= MAX_FAILURES_PER_WINDOW) {
    return { status: 429, error: "Too many failed attempts. Try again later." };
  }
  const expectedPin = env && env.INTAKE_PIN;
  if (expectedPin && String(pin) === String(expectedPin)) {
    if (entry) failures.delete(ip);
    return null;
  }
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    failures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  // Opportunistic cleanup so the map can't grow unbounded on a long-lived isolate.
  if (failures.size > 1000) {
    for (const [key, value] of failures) {
      if (now - value.windowStart >= WINDOW_MS) failures.delete(key);
    }
  }
  return { status: 200, error: "Invalid PIN" };
}
