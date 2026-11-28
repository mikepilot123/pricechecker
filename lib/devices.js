import { sql } from "./db.js";

// Per-device permissions: what each browser registered with the team PIN may
// see. The owner manages them from Settings → Devices with the owner PIN
// (lib/owner-pin.js); assets/device-access.js hides the sections in the app,
// and api/intake.js refuses the data behind them.
//
// Only enforced once an owner PIN exists (see effectiveHidden below), so
// until the owner creates one the app behaves exactly as before.

/** Sections the owner can hide, in the order Settings lists them. */
export const DEVICE_SECTIONS = ["invoiceFigures", "dashboard", "targets", "accounting", "partsOrders"];

// Every device starts with everything hidden, and only sees a section once
// the owner allows it for that device in Settings → Devices.
const NEW_DEVICE_HIDDEN = DEVICE_SECTIONS;

// Devices used to keep full access unless the owner restricted them. The
// first time permissions are checked under the hidden-by-default rule, every
// existing device is reset to hidden once; this marker records that it ran
// so allowances the owner makes afterwards are never undone.
const HIDDEN_BY_DEFAULT_KEY = "device_hidden_by_default";
let hiddenByDefaultApplied = false;

async function applyHiddenByDefault() {
  if (hiddenByDefaultApplied) return;
  const inserted = await sql`
    INSERT INTO app_settings (key, value) VALUES (${HIDDEN_BY_DEFAULT_KEY}, ${JSON.stringify({ since: new Date().toISOString() })}::jsonb)
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
  if (inserted.length) {
    await sql`UPDATE devices SET hidden_sections = ${NEW_DEVICE_HIDDEN}, updated_at = now() WHERE purpose <> 'backup'`;
  }
  hiddenByDefaultApplied = true;
}

// "Waiting on parts" notice for every device at once (Settings → Devices →
// the all-devices button). Remembered so a device that signs in later starts
// the same way; each device can still be switched on its own afterwards.
const PARTS_ALERT_DEFAULT_KEY = "device_hide_parts_alert_default";

async function hidePartsAlertByDefault() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${PARTS_ALERT_DEFAULT_KEY}`;
  return !!rows[0]?.value?.hide;
}

/** Hides (or shows) the notice on every device. Returns how many changed. */
export async function setPartsAlertForAll(hide) {
  const value = !!hide;
  await sql`
    INSERT INTO app_settings (key, value) VALUES (${PARTS_ALERT_DEFAULT_KEY}, ${JSON.stringify({ hide: value })}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  const changed = await sql`
    UPDATE devices SET hide_parts_alert = ${value}, updated_at = now()
    WHERE hide_parts_alert <> ${value}
    RETURNING id
  `;
  return changed.length;
}

// The MASTER device (Settings → Devices, owner PIN): the one device that
// runs the parts check (lib/parts-check.js). Stored in app_settings as
// { id, since } — `since` is when a master was first set, kept when the
// master changes, so the parts check knows which repairs to ask about.
const MASTER_KEY = "master_device";

export async function getMasterSetting() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${MASTER_KEY}`;
  const value = rows[0]?.value || {};
  return { id: value.id || "", since: value.since || "" };
}

/** Makes `id` the master device, or clears it with "". Returns the setting. */
export async function setMasterDevice(id) {
  const deviceId = String(id || "").trim();
  const current = await getMasterSetting();
  if (deviceId) {
    const rows = await sql`SELECT id FROM devices WHERE id = ${deviceId}`;
    if (!rows.length) throw new Error("Device not found");
  }
  const value = { id: deviceId, since: current.since || (deviceId ? new Date().toISOString() : "") };
  await sql`
    INSERT INTO app_settings (key, value) VALUES (${MASTER_KEY}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return value;
}

export async function isMasterDevice(id) {
  if (!id) return false;
  return (await getMasterSetting()).id === id;
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
  // The nightly backup (apps-script/NightlyBackup.gs) signs in from Apps Script.
  if (/Google-Apps-Script/i.test(text)) return "Nightly backup";
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
    purpose: row.purpose || "",
    hidden: cleanHidden(row.hidden_sections),
    // A display choice, not a permission: applies whether or not an owner
    // PIN exists. See migrations/052_add_warranty_and_device_display.sql.
    hidePartsAlert: !!row.hide_parts_alert,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  };
}

/**
 * Records a browser that has just registered with the team PIN: hidden until
 * allowed. The nightly backup registers with purpose "backup" instead: nothing
 * hidden, so it never waits on the owner, but it can only read (see
 * isBackupDevice). The owner can still hide sections from it in Settings.
 */
export async function registerDevice(id, { userAgent = "", purpose = "" } = {}) {
  if (!id) throw new Error("Couldn't identify this browser");
  const backup = purpose === "backup";
  const name = backup ? "Nightly backup" : describeUserAgent(userAgent);
  const hidePartsAlert = await hidePartsAlertByDefault();
  await sql`
    INSERT INTO devices (id, name, user_agent, purpose, hidden_sections, hide_parts_alert)
    VALUES (${id}, ${name}, ${String(userAgent).slice(0, 400)}, ${backup ? "backup" : ""}, ${backup ? [] : NEW_DEVICE_HIDDEN}, ${hidePartsAlert})
    ON CONFLICT (id) DO NOTHING
  `;
}

// A device's purpose never changes, so it's remembered per server instance
// rather than looked up on every request.
const purposeCache = new Map();

/** True for the nightly backup's device, which may only read. */
export async function isBackupDevice(id) {
  if (!id) return false;
  if (!purposeCache.has(id)) {
    const rows = await sql`SELECT purpose FROM devices WHERE id = ${id}`;
    if (!rows.length) return false; // not registered yet: don't cache
    purposeCache.set(id, rows[0].purpose === "backup");
  }
  return purposeCache.get(id);
}

/**
 * The device's row, creating it (hidden until allowed) on first sight — a
 * credential issued before devices were tracked has no row yet.
 */
export async function getDevice(id, { userAgent = "" } = {}) {
  if (!id) return null;
  const rows = await sql`SELECT * FROM devices WHERE id = ${id}`;
  if (!rows.length) {
    const hidden = NEW_DEVICE_HIDDEN;
    const hidePartsAlert = await hidePartsAlertByDefault();
    const created = await sql`
      INSERT INTO devices (id, name, user_agent, hidden_sections, hide_parts_alert)
      VALUES (${id}, ${describeUserAgent(userAgent)}, ${String(userAgent).slice(0, 400)}, ${hidden}, ${hidePartsAlert})
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
  await applyHiddenByDefault();
  if (!id) return [...NEW_DEVICE_HIDDEN];
  const device = await getDevice(id, { userAgent });
  return device.hidden;
}

export async function listDevices() {
  await applyHiddenByDefault();
  const rows = await sql`SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC`;
  const master = (await getMasterSetting()).id;
  return rows.map((row) => ({ ...toDevice(row), isMaster: !!master && row.id === master }));
}

/**
 * Hides everything again on every device but the owner's own. Returns how
 * many devices changed.
 */
export async function restrictOtherDevices(currentId) {
  if (!currentId) throw new Error("Sign this browser in again with the team PIN first, so it isn't restricted too.");
  await getDevice(currentId);
  const changed = await sql`
    UPDATE devices SET hidden_sections = ${NEW_DEVICE_HIDDEN}, updated_at = now()
    WHERE id <> ${currentId} AND purpose <> 'backup' AND cardinality(hidden_sections) < ${NEW_DEVICE_HIDDEN.length}
    RETURNING id
  `;
  return changed.length;
}

export async function updateDevice({ id, name, hidden, hidePartsAlert } = {}) {
  const deviceId = String(id || "").trim();
  if (!deviceId) throw new Error("id is required");
  const rows = await sql`SELECT * FROM devices WHERE id = ${deviceId}`;
  if (!rows.length) throw new Error("Device not found");
  const nextName = name === undefined ? rows[0].name : cleanName(name);
  const nextHidden = hidden === undefined ? cleanHidden(rows[0].hidden_sections) : cleanHidden(hidden);
  const nextHidePartsAlert = hidePartsAlert === undefined ? !!rows[0].hide_parts_alert : !!hidePartsAlert;
  const updated = await sql`
    UPDATE devices
    SET name = ${nextName}, hidden_sections = ${nextHidden}, hide_parts_alert = ${nextHidePartsAlert}, updated_at = now()
    WHERE id = ${deviceId}
    RETURNING *
  `;
  return toDevice(updated[0]);
}
