-- Devices: one row per browser registered with the team PIN, so the owner can
-- choose what each one may see (Settings → Devices, assets/device-access.js).
--
-- id is a hash of the browser credential's random nonce (lib/security.js's
-- deviceIdForCredential), never the credential itself, so this table can't be
-- used to sign in. hidden_sections lists the parts of the app the device may
-- not open; see DEVICE_SECTIONS in lib/devices.js.
--
-- Browsers registered before this table existed have no row. The first time
-- one is seen it's recorded with nothing hidden, and so is any browser that
-- registers while no OWNER_PIN is set: every device in use when the owner
-- turns permissions on keeps full access. Browsers registered after that
-- start with everything hidden until the owner allows it.
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
