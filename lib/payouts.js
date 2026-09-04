import { sql } from "./db.js";
import { syncTakingsReminder } from "./card-payments.js";

// Payouts — see migrations/024_create_payouts.sql.
//
// A payout is one transfer from the card-machine holder back to the shop,
// clearing a batch of settled payments. It is an immutable receipt: the amount
// is derived here from the payments it clears and is never edited afterwards.
// A wrong payout is voided (releasing its payments back to "settled") and
// re-recorded. That is what keeps
//     owed = sum(settled net) - sum(collected net)
// exactly true instead of drifting as figures get hand-corrected.

function text(value) {
  return String(value == null ? "" : value).trim();
}

function timestampFrom(value, field) {
  if (value == null || value === "") return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error(`${field} is invalid`);
  return d.toISOString();
}

function rowToPayout(row) {
  return {
    id: row.id,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    amount: row.amount == null ? 0 : Number(row.amount),
    method: row.method || "",
    reference: row.reference || "",
    notes: row.notes || "",
    paymentCount: row.payment_count == null ? 0 : Number(row.payment_count),
    voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    voidReason: row.void_reason || "",
    created: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function listPayouts() {
  const rows = await sql`
    SELECT p.*, (SELECT COUNT(*) FROM card_payments c WHERE c.payout_id = p.id) AS payment_count
    FROM payouts p
    WHERE p.deleted_at IS NULL
    ORDER BY p.paid_at DESC, p.created_at DESC
  `;
  return rows.map(rowToPayout);
}

/**
 * Record a transfer covering `paymentIds`.
 *
 * The amount is NOT taken from the client — it is summed here from the very
 * rows being cleared, so the books cannot be saved out of balance no matter
 * what the form sends.
 *
 * The whole thing is one statement so it is atomic. Both the insert and the
 * update are gated on the same check — that every requested payment is still
 * settled and uncollected — evaluated against a single snapshot. If anything
 * changed underneath (a second device recorded a payout for one of these
 * moments earlier), neither half runs and this throws, rather than writing a
 * payout whose total silently covers fewer payments than it claims.
 */
export async function addPayout(p) {
  const requested = Array.isArray(p.paymentIds) ? [...new Set(p.paymentIds.map(text).filter(Boolean))] : [];
  if (!requested.length) throw new Error("Select at least one payment to record a payout");
  const id = text(p.id) || "PO" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const paidAt = timestampFrom(p.paidAt, "Payout date");

  const [result] = await sql`
    WITH sel AS (
      SELECT id, (gross - fee) AS net
      FROM card_payments
      WHERE id = ANY(${requested}::text[])
        AND deleted_at IS NULL
        AND voided_at IS NULL
        AND payout_id IS NULL
        AND settles_at <= now()
    ),
    ins AS (
      INSERT INTO payouts (id, paid_at, amount, method, reference, notes)
      SELECT ${id}, ${paidAt}::timestamptz, COALESCE(SUM(net), 0),
             ${text(p.method)}, ${text(p.reference)}, ${text(p.notes)}
      FROM sel
      HAVING COUNT(*) = ${requested.length}
      RETURNING id, amount
    ),
    upd AS (
      UPDATE card_payments
      SET payout_id = ${id}, updated_at = now()
      WHERE id IN (SELECT id FROM sel)
        AND (SELECT COUNT(*) FROM sel) = ${requested.length}
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM sel)::int AS eligible,
           (SELECT COUNT(*) FROM upd)::int AS cleared,
           (SELECT amount FROM ins) AS amount
  `;

  if (Number(result.eligible) !== requested.length) {
    throw new Error(
      `${requested.length - Number(result.eligible)} of these payments can no longer be collected — ` +
      "they may have been voided or already paid out. Reload and try again."
    );
  }
  await syncTakingsReminder();
  return {
    id,
    paidAt,
    amount: Number(result.amount),
    method: text(p.method),
    reference: text(p.reference),
    notes: text(p.notes),
    paymentCount: Number(result.cleared),
    voidedAt: null,
    voidReason: "",
  };
}

/**
 * Undo a payout: its payments drop back to "settled" and re-enter the owed
 * balance. The payout row stays, marked void with its reason, so the history
 * still shows that a transfer was recorded and then corrected.
 */
export async function voidPayout(p) {
  const id = text(p.id);
  if (!id) throw new Error("Payout ID is required");
  const reason = text(p.reason);
  if (!reason) throw new Error("Say why this payout is being voided");
  const rows = await sql`SELECT * FROM payouts WHERE id = ${id} AND deleted_at IS NULL`;
  if (!rows.length) throw new Error("Payout not found: " + id);
  if (rows[0].voided_at) throw new Error("This payout is already voided");
  await sql.transaction([
    sql`
      UPDATE payouts
      SET voided_at = now(), void_reason = ${reason}, updated_at = now()
      WHERE id = ${id} AND voided_at IS NULL
    `,
    sql`UPDATE card_payments SET payout_id = NULL, updated_at = now() WHERE payout_id = ${id}`,
  ]);
  await syncTakingsReminder();
  const [row] = await sql`
    SELECT p.*, (SELECT COUNT(*) FROM card_payments c WHERE c.payout_id = p.id) AS payment_count
    FROM payouts p WHERE p.id = ${id}
  `;
  return rowToPayout(row);
}
