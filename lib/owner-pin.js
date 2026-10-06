import crypto from "node:crypto";
import { sql } from "./db.js";

// The owner PIN: unlocks Settings → Devices (lib/devices.js), and its
// existence is what turns device permissions on.
//
// The owner creates it from that screen, and it's kept in app_settings as a
// salted scrypt hash, never the PIN. An OWNER_PIN env var on the server takes
// its place when set: the way back in if the app's owner PIN is forgotten.

const SETTINGS_KEY = "owner_pin";
const MIN_LENGTH = 4;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function storedPin() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${SETTINGS_KEY}`;
  const value = rows[0]?.value;
  return value && value.hash && value.salt ? value : null;
}

/**
 * Where the owner PIN comes from: "server" (OWNER_PIN env var), "app" (set
 * in Settings → Devices) or "" (none yet, so permissions are off).
 */
export async function ownerPinSource() {
  if (process.env.OWNER_PIN) return "server";
  return (await storedPin()) ? "app" : "";
}

export async function verifyOwnerPin(pin) {
  if (!pin) return false;
  if (process.env.OWNER_PIN) return safeEqual(pin, process.env.OWNER_PIN);
  const stored = await storedPin();
  return !!stored && safeEqual(hashPin(pin, stored.salt), stored.hash);
}

/**
 * Creates the owner PIN, or replaces it. Replacing needs the current one,
 * which the caller checks (with the PIN lockout) before calling. Creating it
 * is first come, first served: the insert only wins if no PIN exists yet.
 */
export async function saveOwnerPin(newPin, { replacing = false } = {}) {
  if (process.env.OWNER_PIN) {
    throw new Error("The owner PIN is set on the server (OWNER_PIN), so it can only be changed there.");
  }
  const pin = String(newPin || "").trim();
  if (pin.length < MIN_LENGTH) throw new Error(`The owner PIN needs at least ${MIN_LENGTH} characters.`);
  if (process.env.INTAKE_PIN && pin === process.env.INTAKE_PIN) {
    throw new Error("Use a different PIN from the team PIN, or anyone on the team could change device access.");
  }
  const salt = crypto.randomBytes(16).toString("base64url");
  const value = JSON.stringify({ salt, hash: hashPin(pin, salt), setAt: new Date().toISOString() });
  const rows = replacing
    ? await sql`
        INSERT INTO app_settings (key, value) VALUES (${SETTINGS_KEY}, ${value}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        RETURNING key
      `
    : await sql`
        INSERT INTO app_settings (key, value) VALUES (${SETTINGS_KEY}, ${value}::jsonb)
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `;
  if (!rows.length) throw new Error("An owner PIN has already been set. Unlock with it instead.");
}
