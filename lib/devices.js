import { sql } from "./db.js";

// Per-device permissions: what each browser registered with the team PIN may
// see. The owner manages them from Settings → Devices with the owner PIN
// (lib/owner-pin.js); assets/device-access.js hides the sections in the app,
// and api/intake.js refuses the data behind them.
//
// Only enforced once an owner PIN exists (see effectiveHidden below), so
// until the owner creates one the app behaves exactly as before.

/** Sections the owner can hide, in the order Settings lists them. */
export const DEVICE_SECTIONS = ["invoiceFigures", "dashboard", "targets", "accounting"];

// A browser registered from now on starts with everything hidden until the
// owner allows it; the team PIN alone shouldn't reveal the shop's figures.
const NEW_DEVICE_HIDDEN = DEVICE_SECTIONS;

// What a browser signed in before devices were tracked gets the first time
// it's seen: full access, until the owner uses "Restrict all other devices"
// (restrictOtherDevices), after which such a browser — which the owner can't
// have reviewed, since it was never listed — starts restricted too.
const UNSEEN_DEVICES_KEY = "device_defaults";

async function unseenDevicesRestricted() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${UNSEEN_DEVICES_KEY}`;
  return rows[0]?.value?.unseenDevices === "restricted";
}

// last_seen_at is a convenience for telling devices apart, not an audit log,
// so it's only written when it's this stale rather than on every app open.
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

function cleanHidden(list) {
  const wanted = new Set(Array.isArray(list) ? list.map(String) : []);
  return DEVICE_SECTIONS.filter((section) => wanted.has(section));
}

function cleanName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
}

/** "iPhone · Safari" — a starting name the owner can rename. */
export function describeUserAgent(ua) {
  const text = String(ua || "");
  const os = /iPad/.test(text) ? "iPad"
    : /iPhone/.test(text) ? "iPhone"
    : /Android/.test(text) ? (/Mobile/.test(text) ? "Android phone" : "Android tablet")
    : /CrOS/.test(text) ? "Chromebook"
    : /Windows/.test(text) ? "Windows"
    : /Macintosh|Mac OS X/.test(text) ? "Mac"
    : /Linux/.test(text) ? "Linux"
    : "";
  const browser = /Edg\//.test(text) ? "Edge"
    : /SamsungBrowser/.test(text) ? "Samsung Internet"
    : /OPR\/|Opera/.test(text) ? "Opera"
    : /Firefox|FxiOS/.test(text) ? "Firefox"
    : /Chrome|CriOS/.test(text) ? "Chrome"
    : /Safari/.test(text) ? "Safari"
    : "";
  return [os, browser].filter(Boolean).join(" · ") || "Unknown device";
}

function toDevice(row) {
  return {
    id: row.id,
    name: row.name || describeUserAgent(row.user_agent),
    userAgent: row.user_agent || "",
    hidden: cleanHidden(row.hidden_sections),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  };
}

/**
 * Records a browser that has just registered with the team PIN. While no owner
 * PIN is set it's recorded with full access, so every device signed in at the
 * moment the owner turns permissions on keeps what it had.
 */
export async function registerDevice(id, { managed, userAgent = "" } = {}) {
  if (!id) throw new Error("Couldn't identify this browser");
  await sql`
    INSERT INTO devices (id, name, user_agent, hidden_sections)
    VALUES (${id}, ${describeUserAgent(userAgent)}, ${String(userAgent).slice(0, 400)}, ${managed ? NEW_DEVICE_HIDDEN : []})
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * The device's row, creating it on first sight. A credential with no row was
 * issued before devices were tracked (registerDevice records every newer
 * one), so that device was already in use and keeps full access — unless the
 * owner has since restricted every other device (restrictOtherDevices).
 */
export async function getDevice(id, { userAgent = "" } = {}) {
  if (!id) return null;
  const rows = await sql`SELECT * FROM devices WHERE id = ${id}`;
  if (!rows.length) {
    const hidden = (await unseenDevicesRestricted()) ? NEW_DEVICE_HIDDEN : [];
    const created = await sql`
      INSERT INTO devices (id, name, user_agent, hidden_sections)
      VALUES (${id}, ${describeUserAgent(userAgent)}, ${String(userAgent).slice(0, 400)}, ${hidden})
      ON CONFLICT (id) DO UPDATE SET last_seen_at = now()
      RETURNING *
    `;
    return toDevice(created[0]);
  }
  const row = rows[0];
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > LAST_SEEN_RESOLUTION_MS) {
    await sql`UPDATE devices SET last_seen_at = now() WHERE id = ${id}`;
    row.last_seen_at = new Date();
  }
  return toDevice(row);
}

/**
 * What this request's device may not see. Nothing while no owner PIN is set.
 * A raw team PIN (no browser credential) can't be told apart from a new
 * device, so it gets a new device's restrictions.
 */
export async function effectiveHidden(id, { managed, userAgent = "" } = {}) {
  if (!managed) return [];
  if (!id) return [...NEW_DEVICE_HIDDEN];
  const device = await getDevice(id, { userAgent });
  return device.hidden;
}

export async function listDevices() {
  const rows = await sql`SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC`;
  return rows.map(toDevice);
}

/**
 * Hides everything on every device but the owner's own, including browsers
 * that haven't been seen since devices started being tracked (they're
 * restricted the first time they turn up). Returns how many listed devices
 * changed.
 */
export async function restrictOtherDevices(currentId) {
  if (!currentId) throw new Error("Sign this browser in again with the team PIN first, so it isn't restricted too.");
  await getDevice(currentId);
  const changed = await sql`
    UPDATE devices SET hidden_sections = ${NEW_DEVICE_HIDDEN}, updated_at = now()
    WHERE id <> ${currentId} AND cardinality(hidden_sections) < ${NEW_DEVICE_HIDDEN.length}
    RETURNING id
  `;
  await sql`
    INSERT INTO app_settings (key, value) VALUES (${UNSEEN_DEVICES_KEY}, ${JSON.stringify({ unseenDevices: "restricted" })}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return changed.length;
}

export async function updateDevice({ id, name, hidden } = {}) {
  const deviceId = String(id || "").trim();
  if (!deviceId) throw new Error("id is required");
  const rows = await sql`SELECT * FROM devices WHERE id = ${deviceId}`;
  if (!rows.length) throw new Error("Device not found");
  const nextName = name === undefined ? rows[0].name : cleanName(name);
  const nextHidden = hidden === undefined ? cleanHidden(rows[0].hidden_sections) : cleanHidden(hidden);
  const updated = await sql`
    UPDATE devices
    SET name = ${nextName}, hidden_sections = ${nextHidden}, updated_at = now()
    WHERE id = ${deviceId}
    RETURNING *
  `;
  return toDevice(updated[0]);
}
