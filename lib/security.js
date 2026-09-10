// Shared request hardening for the api/* handlers.
//
// CORS: the static frontend lives on GitHub Pages, so requests are always
// cross-origin. Previously every handler sent Allow-Origin: * — now only
// known frontends (plus localhost for development) get a CORS pass. Note
// this protects browsers, not curl; the PIN check is still the real gate.
//
// Rate limiting: the PIN bootstraps a durable browser credential, so unlimited guessing was
// the biggest hole. This is a per-instance in-memory counter — serverless
// instances don't share state, so a determined attacker spread across many
// cold starts gets more attempts than the nominal limit, but casual
// brute-forcing against a warm instance goes from thousands of guesses a
// minute to a handful.

import crypto from "node:crypto";

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

const BROWSER_CREDENTIAL_PREFIX = "rpcb1";
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
  const expectedPin = process.env.INTAKE_PIN;
  if (expectedPin && (safeEqual(pin, expectedPin) || validBrowserCredential(pin, expectedPin))) {
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

/**
 * Exchanges a successful PIN sign-in for a random, signed browser credential.
 * The PIN is never embedded in the credential. Credentials intentionally have
 * no clock-based expiry: they remain valid until the team PIN is rotated,
 * which changes the signing key and revokes every registered browser at once.
 */
export function createBrowserCredential(pin) {
  const expectedPin = process.env.INTAKE_PIN;
  if (!expectedPin || !credentialSecret() || !safeEqual(pin, expectedPin)) return null;
  const nonce = crypto.randomBytes(32).toString("base64url");
  const signature = signBrowserNonce(nonce, expectedPin);
  return `${BROWSER_CREDENTIAL_PREFIX}.${nonce}.${signature}`;
}

function validBrowserCredential(value, secret) {
  const parts = String(value || "").split(".");
  if (!credentialSecret() || parts.length !== 3 || parts[0] !== BROWSER_CREDENTIAL_PREFIX || !parts[1] || !parts[2]) return false;
  return safeEqual(parts[2], signBrowserNonce(parts[1], secret));
}

function credentialSecret() {
  // DATABASE_URL is already a high-entropy server-only deployment secret and
  // keeps this backward-compatible. BROWSER_CREDENTIAL_SECRET can be set to
  // decouple credentials from it later without changing the token format.
  return process.env.BROWSER_CREDENTIAL_SECRET || process.env.DATABASE_URL || "";
}

function signBrowserNonce(nonce, pin) {
  return crypto.createHmac("sha256", credentialSecret()).update(nonce).update("\0").update(pin).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
