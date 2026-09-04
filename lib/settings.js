import { sql } from "./db.js";

// Shared app settings — see migrations/025_create_app_settings.sql.
//
// A generic key/value store over one JSONB column. Reads always merge over
// the defaults below, so a key that hasn't been saved yet (or a key added in
// a later deploy than the row was written) still comes back with a sensible
// value rather than undefined.

export const ACCOUNT_SETTINGS_KEY = "account";

// Card-machine terms. Defaults are JQ Electronics' current rates; staff can
// change them in Settings without a redeploy, which is the whole reason this
// table exists.
export const ACCOUNT_DEFAULTS = {
  debitFee: 0.75,      // flat TTD per debit transaction
  creditFeePct: 4,     // percent of gross on credit
  settlementHour: 9,   // shop-local hour on the settlement day when funds are treated as landed
  holdAlertDays: 2,    // nag once something has sat settled-and-uncollected this long
  holderName: "",      // whoever the machine is registered to; used in the reminder text
};

function numberOr(value, fallback) {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

/** Coerce a stored/incoming blob into a complete, valid account settings object. */
function normalizeAccount(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  return {
    debitFee: Math.max(0, numberOr(v.debitFee, ACCOUNT_DEFAULTS.debitFee)),
    creditFeePct: Math.min(100, Math.max(0, numberOr(v.creditFeePct, ACCOUNT_DEFAULTS.creditFeePct))),
    settlementHour: Math.min(23, Math.max(0, Math.round(numberOr(v.settlementHour, ACCOUNT_DEFAULTS.settlementHour)))),
    holdAlertDays: Math.max(0, Math.round(numberOr(v.holdAlertDays, ACCOUNT_DEFAULTS.holdAlertDays))),
    holderName: String(v.holderName == null ? ACCOUNT_DEFAULTS.holderName : v.holderName).trim(),
  };
}

export async function getAccountSettings() {
  const rows = await sql`SELECT value FROM app_settings WHERE key = ${ACCOUNT_SETTINGS_KEY}`;
  return normalizeAccount(rows.length ? rows[0].value : null);
}

/**
 * Partial update — only the keys present in `patch` change, so the Settings
 * form can save one field without having to send (and risk clobbering) the
 * rest.
 */
export async function saveAccountSettings(patch) {
  const current = await getAccountSettings();
  const merged = normalizeAccount({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  await sql`
    INSERT INTO app_settings (key, value)
    VALUES (${ACCOUNT_SETTINGS_KEY}, ${JSON.stringify(merged)}::jsonb)
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now()
  `;
  return merged;
}
