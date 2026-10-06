-- Devices: one row per browser registered with the team PIN, so the owner can
-- choose what each one may see (Settings → Devices, assets/device-access.js).
--
-- id is a hash of the browser credential's random nonce (lib/security.js's
-- deviceIdForCredential), never the credential itself, so this table can't be
-- used to sign in. hidden_sections lists the parts of the app the device may
-- not open; see DEVICE_SECTIONS in lib/devices.js.
--
-- Every device is hidden until the owner allows it. A browser registered
-- before this table existed has no row; it gets one, hidden, the first time
-- it's seen (lib/devices.js).
--
-- Mirrored idempotently in lib/db.js's ensureSchema().
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT '',
  hidden_sections TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
